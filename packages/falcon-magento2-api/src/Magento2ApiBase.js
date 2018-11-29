const Logger = require('@deity/falcon-logger');
const { ApiDataSource } = require('@deity/falcon-server-env');
const { AuthenticationError } = require('@deity/falcon-errors');
const util = require('util');
const { CronJob } = require('cron');
const addMinutes = require('date-fns/add_minutes');
const isPlainObject = require('lodash/isPlainObject');
const camelCase = require('lodash/camelCase');
const keys = require('lodash/keys');
const isEmpty = require('lodash/isEmpty');
const _ = require('lodash');

const { codes } = require('@deity/falcon-errors');

/**
 * Base API features (configuration fetching, response parsing, token management etc.) required for communication
 * with Magento2. Extracted to separate class to keep final class clean (only resolvers-related logic should be there).
 */
module.exports = class Magento2ApiBase extends ApiDataSource {
  /**
   * Create Magento api wrapper instance
   * @param {object} params configuration params
   */
  constructor(params) {
    super(params);
    this.storePrefix = this.config.storePrefix || 'default';
    this.cookie = null;
    this.magentoConfig = {};
    this.storeList = [];
    this.storeConfigMap = {};
    this.setupAdminTokenRefreshJob();
  }

  /**
   * Makes sure that context required for http calls exists
   * Gets basic store configuration from Magento
   * @return {object} Magento config
   */
  async preInitialize() {
    if (!this.context) {
      this.initialize({ context: {} });
    }

    const [storeConfigs, storeViews, storeGroups, storeWebsites] = await Promise.all([
      this.get('/store/storeConfigs'),
      this.get('/store/storeViews'),
      this.get('/store/storeGroups'),
      this.get('/store/websites')
    ]);

    // Processing "active" items only
    const activeStoreViews = storeViews.data.filter(
      storeView => storeView.extension_attributes.is_active && storeView.website_id
    );
    const activeStoreWebsites = storeWebsites.data.filter(storeWebsite => storeWebsite.id);
    const activeStoreGroups = storeGroups.data.filter(storeGroup => storeGroup.id);

    const activeStoreConfigs = storeConfigs.data.map(storeConfig => ({
      ..._.pick(storeConfig, [
        'id',
        'code',
        'website_id',
        'locale',
        'base_currency_code',
        'default_display_currency_code',
        'timezone',
        'weight_unit'
      ]),
      ..._.pick(_.find(activeStoreViews, { id: storeConfig.id }), ['store_group_id', 'name'])
    }));
    this.storeConfigMap = _.keyBy(activeStoreConfigs, 'code');
    this.magentoConfig.locales = _.uniq(_.map(activeStoreConfigs, 'locale'));
    this.magentoConfig.defaultLocale = _.find(activeStoreConfigs, { code: 'default' }).locale;

    activeStoreWebsites.forEach(storeWebsite => {
      const groups = [];
      let defaultGroup = null;
      let defaultStore = null;

      activeStoreGroups.forEach(storeGroup => {
        if (storeGroup.website_id === storeWebsite.id) {
          storeGroup.stores = [];
          activeStoreConfigs.forEach(storeConfig => {
            if (storeConfig.store_group_id === storeGroup.id) {
              storeGroup.stores.push(storeConfig);

              if (storeConfig.id === storeGroup.default_store_id) {
                defaultStore = storeConfig;
              }
            }
          });

          groups.push(storeGroup);
          if (storeGroup.id === storeWebsite.default_group_id) {
            defaultGroup = storeGroup;
          }
        }
      });

      this.storeList.push({
        ...storeWebsite,
        groups,
        defaultGroup,
        defaultStore
      });
    });

    return this.magentoConfig;
  }

  async setShopStore(root, { storeCode }) {
    const storeConfig = this.findStoreConfig(storeCode);
    if (storeConfig) {
      this.session.storeCode = storeCode;
      this.session.currency = storeConfig.default_display_currency_code;
      this.session.baseCurrency = storeConfig.base_currency_code;
      this.session.timezone = storeConfig.timezone;
      this.session.weightUnit = storeConfig.weight_unit;
      this.context.session.locale = storeConfig.locale;
    }

    return this.magentoConfig;
  }

  async setShopCurrency(root, { currency }) {
    const currentStoreConfig = this.getActiveStoreConfig();
    _.forEach(this.storeConfigMap, storeConfig => {
      if (currentStoreConfig.store_group_id === storeConfig.store_group_id) {
        if (storeConfig.default_display_currency_code === currency) {
          this.setShopStore({}, { storeCode: storeConfig.code });
        }
      }
    });
    return this.magentoConfig;
  }

  getActiveStoreConfig() {
    return this.findStoreConfig(this.session.storeCode);
  }

  findStoreConfig(code) {
    return this.storeConfigMap[code];
  }

  initialize(config) {
    super.initialize(config);

    if (!this.context.session) {
      return;
    }

    const { customerToken } = this.session;
    if (customerToken && !this.isCustomerTokenValid(customerToken)) {
      this.session = {};
      this.context.session.save();
    }

    this.ensureStoreCode();
  }

  /**
   * Setup cronjob to check if  admin token is valid and refresh it if required
   */
  setupAdminTokenRefreshJob() {
    // run every minute
    this.refresh = new CronJob(
      '* * * * *',
      async () => {
        if (this.token && !this.isAdminTokenValid()) {
          Logger.debug(`${this.name}: Refresh admin token`);
          await this.retrieveAdminToken();
        }
      },
      null,
      true
    );
  }

  /**
   * Check if admin token is still valid
   * @return {boolean} true if token is valid
   */
  isAdminTokenValid() {
    return !this.tokenExpirationTime || (this.tokenExpirationTime && this.tokenExpirationTime > Date.now());
  }

  /**
   * Make request to the backend for admin token
   * @return {Promise<string>} admin token
   */
  async retrieveAdminToken() {
    Logger.info(`${this.name}: Retrieving admin token.`);

    const response = await this.retrieveToken({ username: this.config.username, password: this.config.password });

    // data available only if retrieveToken is not wrapped with cache.
    const tokenData = this.convertKeys(response.data || response);
    const { token, validTime } = tokenData;
    if (token === undefined) {
      const noTokenError = new Error(
        'Magento Admin token not found. Did you install the falcon-magento2-module on magento?'
      );

      noTokenError.statusCode = 501;
      noTokenError.code = codes.CUSTOMER_TOKEN_NOT_FOUND;
      throw noTokenError;
    } else {
      Logger.info(`${this.name}: Admin token found.`);
    }
    this.token = token;
    this.tokenExpirationTime = null;

    if (validTime) {
      // convert validTime from hours to milliseconds and subtract 5 minutes buffer
      const tokenTimeInMinutes = validTime * 60 - 5;
      const tokenExpirationTime = addMinutes(Date.now(), tokenTimeInMinutes);

      this.tokenExpirationTime = tokenExpirationTime.getTime();
      Logger.debug(`${this.name}: Admin token valid for ${validTime} hours, till ${tokenExpirationTime.toString()}`);
    }

    return this.token;
  }

  /**
   * Retrieve token for given user.
   * @param {string} username magento2 user
   * @param {string} password magento2 user password
   * @return {object} response data
   */
  async retrieveToken({ username, password }) {
    return this.post('/integration/admin/token', { username, password }, { context: { skipAuth: true } });
  }

  /**
   * Helper method to recursively change key naming from underscore (snake case) to camelCase
   * @param {object} data - argument to process
   * @return {object} converted object
   */
  convertKeys(data) {
    // handle simple types
    if (!isPlainObject(data) && !Array.isArray(data)) {
      return data;
    }

    if (isPlainObject(data) && !isEmpty(data)) {
      const keysToConvert = keys(data);
      keysToConvert.forEach(key => {
        data[camelCase(key)] = this.convertKeys(data[key]);

        // remove snake_case key
        if (camelCase(key) !== key) {
          delete data[key];
        }
      });
    }

    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        data[index] = this.convertKeys(item);
      });
    }

    return data;
  }

  /**
   * Resolves url based on passed parameters
   * @param {object} req - request params
   * @return {Promise<URL>} resolved url object
   */
  async resolveURL(req) {
    const { path } = req;
    const { storeCode = this.storePrefix } = this.session;

    return super.resolveURL({ path: `/rest/${storeCode}/V1${path}` });
  }

  /**
   * Authorize all requests, except case when authorization is explicitly disabled via context settings
   * @param {RequestOptions} req - request params
   */
  async willSendRequest(req) {
    const { context } = req;
    context.isAuthRequired = !context.skipAuth;
    await super.willSendRequest(req);
  }

  /**
   * Sets authorization headers for the passed request
   * @param {RequestOptions} req - request input
   */
  async authorizeRequest(req) {
    const { useAdminToken } = req.context || {};
    const { customerToken } = this.session || {};

    let token;
    // FIXME: it looks like `useAdminToken` flag is not used very often and do not cover all api requests
    // there is an assumption that if customer token is not provided then admin token should be used
    if (useAdminToken || !customerToken) {
      token = await this.getAdminToken();
    } else if (this.isCustomerTokenValid(customerToken)) {
      // eslint-disable-next-line prefer-destructuring
      token = customerToken.token;
    } else {
      const sessionExpiredError = new AuthenticationError(`Customer token has expired.`);
      sessionExpiredError.statusCode = 401;
      sessionExpiredError.code = codes.CUSTOMER_TOKEN_EXPIRED;
      throw sessionExpiredError;
    }

    req.headers.set('Authorization', `Bearer ${token}`);
    req.headers.set('Content-Type', 'application/json');
    req.headers.set('Cookie', this.cookie);
  }

  /**
   * Check if authentication token is valid
   * @param {AuthToken} authToken - authentication token
   * @return {boolean} - true if token is valid
   */
  isCustomerTokenValid(authToken) {
    if (!authToken || !authToken.token || !authToken.expirationTime) {
      return false;
    }

    return authToken.expirationTime > Date.now();
  }

  /**
   * Get Magento api authorized admin token or perform request to create it.
   * @return {Promise<string>} token value
   */
  async getAdminToken() {
    if (!this.token) {
      if (!this.reqToken) {
        this.reqToken = this.retrieveAdminToken();
      }

      Logger.debug(`${this.name}: Waiting for admin token.`);

      // this is called multiple times and may cause some problems with error handling
      return this.reqToken;
    }

    return this.token;
  }

  /**
   * Process received response data
   * @param {Response} response - received response from the api
   * @return {object} processed response data
   */
  async didReceiveResponse(response) {
    const cookies = (response.headers.get('set-cookie') || '').split('; ');
    const responseTags = response.headers.get('x-cache-tags');
    const data = await super.didReceiveResponse(response);
    const meta = {};

    if (responseTags) {
      meta.tags = responseTags.split(',');
    }

    if (cookies.length) {
      // For "customer/token" API call - we don't get PHPSESSID cookie
      cookies.forEach(cookieString => {
        if (cookieString.match(/PHPSESSID=(\w+\d+)/)) {
          this.cookie = cookieString.match(/PHPSESSID=(\w+\d+)/)[0];
        }
      });
    }

    const { search_criteria: searchCriteria } = data;

    if (!searchCriteria) {
      // no search criteria in response, simply return data from backend
      return { data, meta };
    }

    const { page_size: perPage = null, current_page: currentPage = 1 } = searchCriteria;
    const { total_count: total } = data;

    // process search criteria
    const pagination = this.processPagination(total, currentPage, perPage);
    return { data: { items: data.items, filters: data.filters || [], pagination }, meta };
  }

  /**
   * Handle error occurred during http response
   * @param {Error} error - error to process
   */
  didEncounterError(error) {
    const { extensions } = error;
    const { response } = extensions || {};

    // Re-formatting error message using provided response data from Magento
    if (response) {
      const { body } = response;
      const { message, parameters } = body || {};

      if (Array.isArray(parameters)) {
        error.message = util.format(message.replace(/(%\d)/g, '%s'), ...parameters);
      } else if (typeof parameters === 'object') {
        error.message = util.format(message.replace(/(%\w+\b)/g, '%s'), ...Object.values(parameters));
      } else {
        error.message = message;
      }
    }

    super.didEncounterError(error);
  }

  /**
   * Ensuring that user gets storeCode in the session with the first hit.
   */
  ensureStoreCode() {
    const { storeCode } = this.session;

    // Checking if current storeCode is valid
    if (this.getActiveStoreConfig()) {
      return;
    }

    // Fixing invalid storeCode
    Logger.debug(`${this.name}: ${storeCode} is invalid, removing cart data`);
    delete this.session.storeCode;
    delete this.session.cart;
    this.setShopStore({}, { storeCode: 'default' });
  }
};
