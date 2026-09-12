import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import type { Envelope, Template, TemplateField } from '@esign/contracts';

test('recovers drafts across devices, connection loss and expired sessions without overwriting other edits', async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/v1/'))
      console.log(
        'API response',
        response.status(),
        new URL(response.url()).pathname.replace(/invitations\/[^/]+/, 'invitations/[redacted]'),
      );
  });
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText('Synthetic signing recovery test', { x: 40, y: 740 });
  const upload = await request.post('/v1/templates', {
    multipart: {
      metadata: JSON.stringify({
        name: `Recovery ${testInfo.project.name} ${Date.now()}`,
        sourceName: 'Synthetic QA only',
        licenseOwner: 'QA',
        edition: '1',
        effectiveDate: '2026-09-12',
        jurisdiction: 'NY',
        businessDomain: 'REAL_ESTATE',
        approvalRequired: false,
        retentionPolicyId: 'real-estate-7y',
      }),
      file: {
        name: 'recovery.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const template: Template = (await upload.json()).data;
  const version = template.versions[0]!;
  const role = version.roles[0]!;
  const fields: TemplateField[] = (['text', 'signature'] as const).map((type, index) => ({
    id: crypto.randomUUID(),
    documentId: version.documents[0]!.id,
    page: 1,
    type,
    roleId: role.id,
    label: type === 'text' ? 'Your name' : 'Signer signature',
    required: true,
    readOnly: false,
    sensitive: false,
    tabIndex: index,
    rect: { x: 0.1, y: 0.2 + index * 0.2, width: 0.7, height: 0.08, rotation: 0 },
  }));
  expect(
    (
      await request.patch(`/v1/templates/${template.id}/versions/${version.id}`, {
        data: { roles: version.roles, fields },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await request.post(`/v1/templates/${template.id}/versions/${version.id}/publish`)).status(),
  ).toBe(200);
  const created = await request.post('/v1/envelopes', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      templateId: template.id,
      subject: 'Synthetic recovery agreement',
      message: 'Test only',
      expiresAt: '2027-01-01T00:00:00.000Z',
      recipients: [{ roleId: role.id, name: 'QA Signer', email: 'signer@example.test' }],
      mergeData: {},
    },
  });
  expect(created.status()).toBe(201);
  const envelope: Envelope = (await created.json()).data;
  const sent = await request.post(`/v1/envelopes/${envelope.id}/send`, {
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  const link = new URL((await sent.json()).data.invitationUrls[0]);
  // A temporary fetch failure must not be described as an expired invitation.
  await page.route('**/v1/invitations/*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Temporary test outage' } }),
    }),
  );
  await page.goto(link.pathname);
  await expect(page.getByRole('heading', { name: 'We couldn’t connect' })).toBeVisible();
  await page.unroute('**/v1/invitations/*');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'I agree and want to continue' }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Saved without a save button');
  await expect(page.getByRole('status')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue(
    'Saved without a save button',
  );
  // Closing the browser or expiring its cookies must preserve the server draft.
  await page.context().clearCookies();
  await page.getByRole('textbox', { name: 'Your name' }).fill('After session expiry');
  await expect(page.getByRole('status')).toHaveText('All changes saved');
  await page.context().setOffline(true);
  await page.getByRole('textbox', { name: 'Your name' }).fill('Kept while offline');
  await expect(page.getByRole('status')).toHaveText('Changes have not been saved');
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue('Kept while offline');
  await page.context().setOffline(false);
  await expect(page.getByRole('status')).toHaveText('All changes saved');
  const other = await browser.newContext();
  const second = await other.newPage();
  second.on('response', async (response) => {
    if (response.status() >= 400 && response.url().includes('/v1/'))
      console.log('Second device API error', response.status(), await response.text());
  });
  await second.goto(link.toString());
  await expect(second.getByRole('textbox', { name: 'Your name' })).toHaveValue(
    'Kept while offline',
  );
  await second.getByRole('textbox', { name: 'Your name' }).fill('Latest on another device');
  await expect(second.getByRole('status')).toHaveText('All changes saved');
  await page.getByRole('textbox', { name: 'Your name' }).fill('Stale device edit');
  await expect(page.getByRole('alert')).toContainText('another session');
  const latest = await request.get(`/v1/envelopes/${envelope.id}`);
  expect((await latest.json()).data.recipients[0].values[fields[0]!.id]).toBe(
    'Latest on another device',
  );
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Review latest saved progress' }).click();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue(
    'Latest on another device',
  );
  await other.close();
  await page.getByRole('button', { name: 'Signer signature', exact: true }).click();
  await page.getByRole('checkbox', { name: /I intend this electronic mark/ }).check();
  await page.getByRole('button', { name: 'Adopt signature', exact: true }).click();
  await page.getByRole('button', { name: 'Adopt & finish' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you. You’re finished.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Thank you. You’re finished.' })).toBeVisible();
  await expect(page.getByText('You do not need to sign again.', { exact: false })).toBeVisible();
});
