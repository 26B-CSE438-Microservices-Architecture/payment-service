const { v4: uuidv4 } = require('uuid');

class MockProvider {
  constructor() {
    this.formSessions = new Map(); // token -> session data
  }

  async initCheckoutForm({ paymentId, amount, currency, buyer, items, callbackUrl }) {
    await this._delay(50);

    const token = `mock_cf_${uuidv4()}`;
    this.formSessions.set(token, {
      paymentId,
      amount,
      items,
      callbackUrl,
    });

    const amountDisplay = (amount / 100).toFixed(2);
    const mockHtml = Buffer.from(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#1e293b;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:32px;width:420px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.logo{font-size:20px;font-weight:700;color:#1e40af;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:16px}
.amount{font-size:32px;font-weight:700;margin:12px 0}
.field{text-align:left;margin-bottom:12px}
.field label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:4px}
.field input{width:100%;padding:10px;border:2px solid #cbd5e1;border-radius:8px;font-size:14px}
.field input:focus{border-color:#2563eb;outline:none}
.row{display:flex;gap:10px}
.row .field{flex:1}
.presets{margin:12px 0;display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.presets button{padding:4px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;font-size:11px;cursor:pointer;color:#475569}
.presets button:hover{background:#e2e8f0}
.actions{display:flex;gap:10px;margin-top:16px}
.actions button{flex:1;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-ok{background:#16a34a;color:#fff}
.btn-ok:hover{background:#15803d}
.btn-no{background:#dc2626;color:#fff}
.btn-no:hover{background:#b91c1c}
</style></head><body>
<div class="card">
<div class="logo">iyzico Checkout Form</div>
<div class="sub">Mock Payment Gateway</div>
<div class="amount">${amountDisplay} TRY</div>
<div class="presets">
<button onclick="fillCard('5528790000000008','12','2030','123','Test User')">Halkbank MC (OK)</button>
<button onclick="fillCard('4111111111111129','12','2030','123','Test User')">Declined</button>
<button onclick="fillCard('4111111111111111','12','2030','123','Test User')">Insufficient</button>
<button onclick="fillCard('4111111111111100','12','2030','123','Test User')">Expired</button>
</div>
<div class="field"><label>Card Number</label><input id="cn" type="text" maxlength="19" placeholder="5528 7900 0000 0008"></div>
<div class="row">
<div class="field"><label>Month</label><input id="em" type="text" maxlength="2" placeholder="12"></div>
<div class="field"><label>Year</label><input id="ey" type="text" maxlength="4" placeholder="2030"></div>
<div class="field"><label>CVC</label><input id="cv" type="text" maxlength="4" placeholder="123"></div>
</div>
<div class="field"><label>Card Holder</label><input id="ch" type="text" placeholder="Test User"></div>
<div class="actions">
<button class="btn-ok" onclick="submitForm('success')">Pay ${amountDisplay} TRY</button>
<button class="btn-no" onclick="submitForm('fail')">Cancel</button>
</div>
</div>
<form id="f" method="POST" action="${callbackUrl}">
<input type="hidden" name="token" value="${token}">
<input type="hidden" name="cardNumber" id="hcn" value="">
<input type="hidden" name="mockOutcome" id="hmo" value="success">
</form>
<script>
function fillCard(n,m,y,c,h){document.getElementById('cn').value=n;document.getElementById('em').value=m;document.getElementById('ey').value=y;document.getElementById('cv').value=c;document.getElementById('ch').value=h}
function submitForm(outcome){
document.getElementById('hcn').value=document.getElementById('cn').value.replace(/\\s/g,'');
document.getElementById('hmo').value=outcome;
document.getElementById('f').submit();
}
</script>
</body></html>`).toString('base64');

    return { token, content: mockHtml, paymentPageUrl: null };
  }

  async retrieveCheckoutForm(token) {
    await this._delay(50);

    const session = this.formSessions.get(token);
    if (!session) {
      return { success: false, failureReason: 'form_not_found' };
    }

    const outcome = session.outcome || 'success';
    const cardNumber = session.cardNumber || '5528790000000008';

    this.formSessions.delete(token);

    if (outcome !== 'success') {
      let failureReason = 'payment_cancelled_by_user';
      if (cardNumber === '4111111111111129') failureReason = 'card_declined';
      else if (cardNumber === '4111111111111111') failureReason = 'insufficient_funds';
      else if (cardNumber === '4111111111111100') failureReason = 'card_expired';
      return { success: false, failureReason };
    }

    if (cardNumber === '4111111111111129') {
      return { success: false, failureReason: 'card_declined' };
    }
    if (cardNumber === '4111111111111111') {
      return { success: false, failureReason: 'insufficient_funds' };
    }
    if (cardNumber === '4111111111111100') {
      return { success: false, failureReason: 'card_expired' };
    }

    return {
      success: true,
      providerTxId: `mock_tx_${uuidv4()}`,
      itemTransactions: this._buildMockItemTransactions(session.items, session.amount),
    };
  }

  // Tag a form session with data from the callback (called by the simulator)
  tagFormSession(token, { outcome, cardNumber }) {
    const session = this.formSessions.get(token);
    if (session) {
      if (outcome) session.outcome = outcome;
      if (cardNumber) session.cardNumber = cardNumber;
    }
  }

  async capture({ providerTxId }) {
    await this._delay(50);
    if (providerTxId === 'mock_tx_capture_fail') throw new Error('Capture failed at provider');
    return { success: true };
  }

  async void({ providerTxId }) {
    await this._delay(50);
    if (providerTxId === 'mock_tx_void_fail') throw new Error('Void failed at provider');
    return { success: true };
  }

  async refund({ providerTxId }) {
    await this._delay(50);
    if (providerTxId === 'mock_tx_refund_fail') throw new Error('Refund failed at provider');
    return { success: true };
  }

  _buildMockItemTransactions(items, amount) {
    if (items && items.length > 0) {
      return items.map((item, i) => ({
        itemId: item.id || `ITEM_${i}`,
        paymentTransactionId: `mock_txn_${uuidv4()}`,
        price: String(item.price || item.amount || 0),
      }));
    }
    return [{
      itemId: 'ITEM_DEFAULT',
      paymentTransactionId: `mock_txn_${uuidv4()}`,
      price: String(amount),
    }];
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = MockProvider;
