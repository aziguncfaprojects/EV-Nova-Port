# Keyra Authenticator

A private, mobile-first TOTP authenticator that can be installed as a Progressive Web App.

## Run locally

```bash
npm install
npm run dev
```

Use HTTPS or `localhost` to enable camera scanning and clipboard access.

## Microsoft sign-in

Add a personal account or a work or school account, then scan the verification-code QR Microsoft shows after you choose a different authenticator app. At a Microsoft prompt, choose **Use a verification code** and enter the 6-digit code. Microsoft push approvals stay with Microsoft Authenticator; their setup QR is recognized and Keyra points you to the verification-code QR instead.

## Privacy

Authenticator secrets are stored only in the browser's local storage. Keyra does not transmit or back up secrets. Keep recovery codes for every account in a safe place before relying on any authenticator.
