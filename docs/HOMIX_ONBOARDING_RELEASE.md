# Homix onboarding on Documenso

Use [DEPLOYMENT.md](DEPLOYMENT.md) for current runtime and release gates, [SIGNING_OPERATIONS.md](SIGNING_OPERATIONS.md) for identity/package setup, and [the Portal integration plan](DOCUMENSO_PORTAL_PLAN.md) for business requirements.

Both legal entities use the user-confirmed company signer **Si Zhang / hr@homixny.com**. The 11 approved onboarding/Team Leader package versions are published in separate company HR teams. Ordinary agent editor connections never share HR credentials.

Portal keeps the agreed rules: after the applicant signs, Stripe payment automatically opens the account; verified offline payment uses administrator approval. Company countersignature is a separate visible task and is not impersonated by an administrator or inferred from account activation. Paper/historical verification remains an independent source of contract evidence.

Portal uses only `ESIGN_BRIDGE_BASE_URL`, `ESIGN_BRIDGE_API_KEY` and `ESIGN_PORTAL_CALLBACK_SECRET`. The previous template pins, application key and native provider API belong to the [archived release runbook](archive/native-platform-2026-09-12/HOMIX_ONBOARDING_RELEASE.md).
