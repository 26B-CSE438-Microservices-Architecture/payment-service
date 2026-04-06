const { v4: uuidv4 } = require('uuid');
const config = require('../config');

class MockProvider {
  constructor() {
    this.cardStore = new Map(); // cardUserKey -> [{ cardToken, last4, ... }]
  }

  async authorize({ amount, currency, card, buyer, items, paymentId, callbackUrl, registerCard }) {
    await this._delay(50);

    // Determine test card number — support raw card, saved card token, or old token format
    const testId = card.cardNumber || card.cardToken || card.token || '';

    // Special test cards/tokens for simulating failures
    if (testId === 'tok_decline' || testId === '4111111111111129') {
      return { type: 'direct', success: false, failureReason: 'card_declined' };
    }
    if (testId === 'tok_insufficient' || testId === '4111111111111111') {
      return { type: 'direct', success: false, failureReason: 'insufficient_funds' };
    }
    if (testId === 'tok_expired' || testId === '4111111111111100') {
      return { type: 'direct', success: false, failureReason: 'card_expired' };
    }
    if (testId === 'tok_error') {
      throw new Error('Provider unavailable');
    }

    const mockTxId = `mock_tx_${uuidv4()}`;
    const mockItemTransactions = (items && items.length > 0)
      ? items.map((item, i) => ({
          itemId: item.id || `ITEM_${i}`,
          paymentTransactionId: `mock_txn_${uuidv4()}`,
          price: String(item.price || item.amount || 0),
        }))
      : [{
          itemId: 'ITEM_DEFAULT',
          paymentTransactionId: `mock_txn_${uuidv4()}`,
          price: String(amount),
        }];

    // 3DS flow
    if (config.payment3dsEnabled) {
      // Special token/card to skip 3DS even when enabled
      if (testId === 'tok_no3ds') {
        return {
          type: 'direct',
          success: true,
          providerTxId: mockTxId,
          itemTransactions: mockItemTransactions,
        };
      }

      // Return 3DS redirect (matches iyzico's response shape)
      const amountDisplay = (amount / 100).toFixed(2);
      const mockHtml = Buffer.from(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#1e293b;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:32px;width:380px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.logo{font-size:20px;font-weight:700;color:#1e40af;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:20px}
.amount{font-size:32px;font-weight:700;margin:16px 0}
.info{font-size:13px;color:#475569;background:#f1f5f9;padding:12px;border-radius:8px;margin-bottom:16px;line-height:1.5}
.sms{width:160px;text-align:center;font-size:24px;letter-spacing:8px;padding:10px;border:2px solid #cbd5e1;border-radius:8px;margin:0 auto 20px;display:block}
.sms:focus{border-color:#2563eb;outline:none}
.actions{display:flex;gap:10px}
.actions button{flex:1;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-ok{background:#16a34a;color:#fff}
.btn-ok:hover{background:#15803d}
.btn-no{background:#dc2626;color:#fff}
.btn-no:hover{background:#b91c1c}
</style></head><body>
<div class="card">
<div class="logo">3D Secure Verification</div>
<div class="sub">Your bank requires additional verification</div>
<div class="amount">${amountDisplay} TRY</div>
<div class="info">A verification code has been sent to your phone ending in **42.<br>Enter the code below to confirm this payment.</div>
<input class="sms" type="text" maxlength="6" value="123456">
<div class="actions">
<button class="btn-ok" onclick="submit3DS('success')">Confirm Payment</button>
<button class="btn-no" onclick="submit3DS('fail')">Cancel</button>
</div>
</div>
<form id="f" method="POST" action="${callbackUrl || '/3ds-return'}">
<input type="hidden" name="paymentId" value="${mockTxId}">
<input type="hidden" name="conversationData" id="cd" value="mock_conv_approve">
<input type="hidden" name="mdStatus" id="md" value="1">
<input type="hidden" name="status" id="st" value="success">
</form>
<script>
function submit3DS(type){
document.getElementById('cd').value=type==='success'?'mock_conv_approve':'mock_conv_fail';
document.getElementById('md').value=type==='success'?'1':'0';
document.getElementById('st').value=type==='success'?'success':'failure';
document.getElementById('f').submit();
}
</script>
</body></html>`).toString('base64');

      return {
        type: '3ds_redirect',
        threeDSHtmlContent: mockHtml,
        providerPaymentId: mockTxId,
      };
    }

    // Direct success
    const response = {
      type: 'direct',
      success: true,
      providerTxId: mockTxId,
      itemTransactions: mockItemTransactions,
    };
    if (registerCard === '1') {
      response.cardUserKey = `mock_cuk_${uuidv4()}`;
      response.cardToken = `mock_ct_${uuidv4()}`;
      response.last4 = (card.cardNumber || '').slice(-4);
      response.cardAssociation = 'VISA';
      response.cardType = 'CREDIT';
      response.cardBankName = 'Mock Bank';
    }
    return response;
  }

  async complete3DS({ providerPaymentId, conversationData }) {
    await this._delay(50);

    // Simulate 3DS failure
    if (conversationData === 'mock_conv_fail') {
      return { success: false, failureReason: '3ds_authentication_failed' };
    }

    return {
      success: true,
      providerTxId: providerPaymentId || `mock_tx_${uuidv4()}`,
      itemTransactions: [{
        itemId: 'ITEM_DEFAULT',
        paymentTransactionId: `mock_txn_${uuidv4()}`,
        price: '0',
      }],
      // Card data for save-during-payment (PaymentService only uses if metadata.saveCard is true)
      cardUserKey: `mock_cuk_${uuidv4()}`,
      cardToken: `mock_ct_${uuidv4()}`,
      last4: '0000',
      cardAssociation: 'VISA',
      cardType: 'CREDIT',
      cardBankName: 'Mock Bank',
    };
  }

  async capture({ providerTxId, amount, currency }) {
    await this._delay(50);

    if (providerTxId === 'mock_tx_capture_fail') {
      throw new Error('Capture failed at provider');
    }

    return { success: true };
  }

  async void({ providerTxId }) {
    await this._delay(50);

    if (providerTxId === 'mock_tx_void_fail') {
      throw new Error('Void failed at provider');
    }

    return { success: true };
  }

  async refund({ providerTxId, amount, metadata }) {
    await this._delay(50);

    if (providerTxId === 'mock_tx_refund_fail') {
      throw new Error('Refund failed at provider');
    }

    return { success: true };
  }

  async registerCard({ card, email, cardUserKey, cardAlias }) {
    await this._delay(50);

    const key = cardUserKey || `mock_cuk_${uuidv4()}`;
    const token = `mock_ct_${uuidv4()}`;
    const last4 = (card.cardNumber || '').slice(-4);
    const entry = {
      cardToken: token,
      last4,
      cardAlias: cardAlias || 'Card',
      cardAssociation: 'VISA',
      cardType: 'CREDIT',
      cardBankName: 'Mock Bank',
    };

    if (!this.cardStore.has(key)) this.cardStore.set(key, []);
    this.cardStore.get(key).push(entry);

    return {
      cardUserKey: key,
      cardToken: token,
      last4,
      cardAssociation: 'VISA',
      cardType: 'CREDIT',
      cardBankName: 'Mock Bank',
    };
  }

  async deleteCard({ cardUserKey, cardToken }) {
    await this._delay(50);

    const cards = this.cardStore.get(cardUserKey);
    if (cards) {
      const idx = cards.findIndex((c) => c.cardToken === cardToken);
      if (idx !== -1) cards.splice(idx, 1);
    }

    return { success: true };
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = MockProvider;
