import React from 'react';
import { PaymentPluginModel } from './PaymentPlugin';

export class SimplePayment extends PaymentPluginModel {
  componentDidMount() {
    this.props.onPaymentDetailsReady();
  }

  render() {
    return null;
  }
}
