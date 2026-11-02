# Browser Extension Skeleton

This directory is a Manifest V3 packaging skeleton. It is not installed or
loaded by the desktop application yet.

The production extension still needs to provide:

- a browser-specific `background.js` entry point;
- a Native Messaging host registration;
- a page snapshot provider that only reports diagnostics/candidate data;
- a user-visible connection and permission flow.

The shared implementation belongs in `src/` and must use the protocol package.
It must not persist passwords, cookies, tokens, or raw design responses.
