const Iyzipay = require('iyzipay');

const iyzipay = new Iyzipay({
    apiKey: 'sandbox-oTAbqHouHUXdFLfGLxTBPFrcUheXvlVu',
    secretKey: 'sandbox-yvv1s9gYLrE5fsZUsHiVMhemGcXGSZTp',
    uri: 'https://sandbox-api.iyzipay.com'
});

iyzipay.apiTest.retrieve({}, function (err, result) {
    if (err) {
        console.error('Connection error:', err);
        process.exit(1);
    }
    console.log('Iyzico API Test Result:', JSON.stringify(result, null, 2));
    if (result.status === 'success') {
        console.log('SUCCESS: Iyzico settings are working correctly.');
        process.exit(0);
    } else {
        console.error('FAILURE: Iyzico settings are incorrect or API is down.');
        process.exit(1);
    }
});
