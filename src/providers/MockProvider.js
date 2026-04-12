const { v4: uuidv4 } = require('uuid');

class MockProvider {
  constructor() {
    this.cardStore = new Map(); // cardUserKey -> [{ cardToken, last4, ... }]
    this.formSessions = new Map(); // token -> session data (for CF and card storage)
  }

  async authorize({ amount, currency, card, buyer, items, paymentId }) {
    await this._delay(50);

    // Saved-card path only — raw card details are never accepted
    const testId = card.cardToken || card.token || '';

    // Special test tokens for simulating failures
    if (testId === 'tok_decline') {
      return { success: false, failureReason: 'card_declined' };
    }
    if (testId === 'tok_insufficient') {
      return { success: false, failureReason: 'insufficient_funds' };
    }
    if (testId === 'tok_expired') {
      return { success: false, failureReason: 'card_expired' };
    }
    if (testId === 'tok_error') {
      throw new Error('Provider unavailable');
    }

    const mockTxId = `mock_tx_${uuidv4()}`;
    const mockItemTransactions = this._buildMockItemTransactions(items, amount);

    return {
      success: true,
      providerTxId: mockTxId,
      itemTransactions: mockItemTransactions,
    };
  }

  async initCheckoutForm({ paymentId, amount, currency, buyer, items, callbackUrl }) {
    await this._delay(50);

    const token = `mock_cf_${uuidv4()}`;
    this.formSessions.set(token, {
      type: 'payment',
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
.check{display:flex;align-items:center;gap:8px;margin:12px 0;font-size:13px;color:#475569}
.check input{width:16px;height:16px}
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
<label class="check"><input id="sc" type="checkbox"> Save this card for future payments</label>
<div class="actions">
<button class="btn-ok" onclick="submitForm('success')">Pay ${amountDisplay} TRY</button>
<button class="btn-no" onclick="submitForm('fail')">Cancel</button>
</div>
</div>
<form id="f" method="POST" action="${callbackUrl}">
<input type="hidden" name="token" value="${token}">
<input type="hidden" name="cardNumber" id="hcn" value="">
<input type="hidden" name="saveCard" id="hsc" value="0">
<input type="hidden" name="mockOutcome" id="hmo" value="success">
</form>
<script>
function fillCard(n,m,y,c,h){document.getElementById('cn').value=n;document.getElementById('em').value=m;document.getElementById('ey').value=y;document.getElementById('cv').value=c;document.getElementById('ch').value=h}
function submitForm(outcome){
document.getElementById('hcn').value=document.getElementById('cn').value.replace(/\\s/g,'');
document.getElementById('hsc').value=document.getElementById('sc').checked?'1':'0';
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
    if (!session || session.type !== 'payment') {
      return { success: false, failureReason: 'form_not_found' };
    }

    // Read outcome from the session (tagged by the simulator callback handler)
    const outcome = session.outcome || 'success';
    const cardNumber = session.cardNumber || '5528790000000008';

    this.formSessions.delete(token);

    if (outcome !== 'success') {
      // Map test card numbers to specific failure reasons
      let failureReason = 'payment_cancelled_by_user';
      if (cardNumber === '4111111111111129') failureReason = 'card_declined';
      else if (cardNumber === '4111111111111111') failureReason = 'insufficient_funds';
      else if (cardNumber === '4111111111111100') failureReason = 'card_expired';

      return { success: false, failureReason };
    }

    // Test card failure detection (even if user clicked "success")
    if (cardNumber === '4111111111111129') {
      return { success: false, failureReason: 'card_declined' };
    }
    if (cardNumber === '4111111111111111') {
      return { success: false, failureReason: 'insufficient_funds' };
    }
    if (cardNumber === '4111111111111100') {
      return { success: false, failureReason: 'card_expired' };
    }

    const mockTxId = `mock_tx_${uuidv4()}`;
    const mockItemTransactions = this._buildMockItemTransactions(session.items, session.amount);

    const response = {
      success: true,
      providerTxId: mockTxId,
      itemTransactions: mockItemTransactions,
    };

    // If user opted to save card, return card details
    if (session.saveCard) {
      const cuk = `mock_cuk_${uuidv4()}`;
      const ct = `mock_ct_${uuidv4()}`;
      response.cardUserKey = cuk;
      response.cardToken = ct;
      response.last4 = cardNumber.slice(-4);
      response.cardAssociation = 'MASTER_CARD';
      response.cardType = 'CREDIT';
      response.cardBankName = 'Mock Bank';

      // Also store in cardStore for consistency
      if (!this.cardStore.has(cuk)) this.cardStore.set(cuk, []);
      this.cardStore.get(cuk).push({ cardToken: ct, last4: cardNumber.slice(-4) });
    }

    return response;
  }

  async initUniversalCardStorage({ email, cardUserKey, cardAlias, callbackUrl }) {
    await this._delay(50);

    const token = `mock_cs_${uuidv4()}`;
    this.formSessions.set(token, {
      type: 'card_storage',
      email,
      cardUserKey,
      cardAlias,
      callbackUrl,
    });

    const mockHtml = Buffer.from(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#1e293b;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:32px;width:420px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.logo{font-size:20px;font-weight:700;color:#1e40af;margin-bottom:4px}
.sub{color:#64748b;font-size:13px;margin-bottom:16px}
.field{text-align:left;margin-bottom:12px}
.field label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:4px}
.field input{width:100%;padding:10px;border:2px solid #cbd5e1;border-radius:8px;font-size:14px}
.field input:focus{border-color:#2563eb;outline:none}
.row{display:flex;gap:10px}
.row .field{flex:1}
.actions{display:flex;gap:10px;margin-top:16px}
.actions button{flex:1;padding:12px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-ok{background:#1e40af;color:#fff}
.btn-ok:hover{background:#1e3a8a}
.btn-no{background:#dc2626;color:#fff}
.btn-no:hover{background:#b91c1c}
</style></head><body>
<div class="card">
<div class="logo">iyzico Card Storage</div>
<div class="sub">Mock Card Vault</div>
<div class="field"><label>Card Number</label><input id="cn" type="text" maxlength="19" placeholder="5528 7900 0000 0008" value="5528790000000008"></div>
<div class="row">
<div class="field"><label>Month</label><input id="em" type="text" maxlength="2" placeholder="12" value="12"></div>
<div class="field"><label>Year</label><input id="ey" type="text" maxlength="4" placeholder="2030" value="2030"></div>
<div class="field"><label>CVC</label><input id="cv" type="text" maxlength="4" placeholder="123" value="123"></div>
</div>
<div class="field"><label>Card Holder</label><input id="ch" type="text" placeholder="Test User" value="Test User"></div>
<div class="actions">
<button class="btn-ok" onclick="submitForm('success')">Save Card</button>
<button class="btn-no" onclick="submitForm('fail')">Cancel</button>
</div>
</div>
<form id="f" method="POST" action="${callbackUrl}">
<input type="hidden" name="token" value="${token}">
<input type="hidden" name="cardNumber" id="hcn" value="">
<input type="hidden" name="mockOutcome" id="hmo" value="success">
</form>
<script>
function submitForm(outcome){
document.getElementById('hcn').value=document.getElementById('cn').value.replace(/\\s/g,'');
document.getElementById('hmo').value=outcome;
document.getElementById('f').submit();
}
</script>
</body></html>`).toString('base64');

    return { token, content: mockHtml };
  }

  async retrieveCardStorageForm(token) {
    await this._delay(50);

    const session = this.formSessions.get(token);
    if (!session || session.type !== 'card_storage') {
      throw new Error('Card storage form not found or already used');
    }

    const outcome = session.outcome || 'success';
    const cardNumber = session.cardNumber || '5528790000000008';

    this.formSessions.delete(token);

    if (outcome !== 'success') {
      throw new Error('Card storage cancelled by user');
    }

    const cuk = session.cardUserKey || `mock_cuk_${uuidv4()}`;
    const ct = `mock_ct_${uuidv4()}`;
    const last4 = cardNumber.slice(-4);

    // Store in cardStore for deleteCard consistency
    if (!this.cardStore.has(cuk)) this.cardStore.set(cuk, []);
    this.cardStore.get(cuk).push({ cardToken: ct, last4 });

    return {
      cardUserKey: cuk,
      cardToken: ct,
      last4,
      cardAssociation: 'MASTER_CARD',
      cardType: 'CREDIT',
      cardBankName: 'Mock Bank',
    };
  }

  // Tag a form session with data from the callback (called by the simulator/route handler)
  tagFormSession(token, { outcome, cardNumber, saveCard }) {
    const session = this.formSessions.get(token);
    if (session) {
      if (outcome) session.outcome = outcome;
      if (cardNumber) session.cardNumber = cardNumber;
      if (saveCard !== undefined) session.saveCard = saveCard === '1' || saveCard === true;
    }
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
