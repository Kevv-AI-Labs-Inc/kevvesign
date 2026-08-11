# Data classification

| Class                 | Examples                                                           | Logging              | Storage                                   | Delivery               |
| --------------------- | ------------------------------------------------------------------ | -------------------- | ----------------------------------------- | ---------------------- |
| Restricted credential | Invitation, session, API key, access code, manifest private key    | Never                | Hash or Key Vault only                    | Secure channel only    |
| Restricted content    | Signature image, SSN/bank/medical value, completed HR PDF          | Never                | Private encrypted object; least privilege | Secure link only       |
| Confidential record   | Licensed PDF, real-estate agreement, ordinary HR form, field value | Identifier/hash only | Private encrypted object                  | Secure link by default |
| Internal metadata     | Status, template edition, routing group, safe audit category       | Allowed if minimized | SQL/Blob                                  | Internal UI/API        |
| Public operational    | Health status, product name                                        | Allowed              | Any approved service                      | Public health endpoint |

No production form, real person, or customer PII may be used in development, CI, preview, or synthetic pilot fixtures.
