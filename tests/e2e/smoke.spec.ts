import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('staff console exposes the primary signing operations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good morning/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /New envelope/i })).toBeVisible();
  await expect(page.getByText('NY · NJ · CA')).toBeVisible();
});

test('invitation error does not reveal envelope existence', async ({ page }) => {
  await page.goto('/sign/not-a-valid-invitation-token-that-is-long-enough');
  await expect(page.getByRole('heading', { name: /invitation can’t be used/i })).toBeVisible();
  await expect(
    page.getByText(/expired, been replaced, or the envelope may already be complete/i),
  ).toBeVisible();
});

test('workspace administrator can issue, rotate, and revoke an application credential', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Credential administration is exercised once.');
  const clientName = `Browser integration ${Date.now()}`;
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Application credentials' })).toBeVisible();
  await page.getByLabel('Integration name').fill(clientName);
  await page
    .getByLabel('Allowed Portal return URL')
    .fill('https://portal.homixliving.com/esign/return');
  await page.getByRole('button', { name: 'Issue credential' }).click();
  await expect(page.getByText('Copy this credential now')).toBeVisible();
  const clientRow = page.locator('.client-row').filter({ hasText: clientName });
  await expect(clientRow).toBeVisible();
  await clientRow.getByRole('button', { name: 'Rotate' }).click();
  await expect(page.getByText(/previous value is invalid/i)).toBeVisible();
  await clientRow.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Integration credential revoked.')).toBeVisible();
  await expect(clientRow.getByText('Revoked', { exact: true })).toBeVisible();
});

test('Homix Portal handoff opens the delegated workspace without another login', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Portal handoff is exercised once.');
  const clientResponse = await request.post('/v1/application-clients', {
    data: {
      name: `Homix Portal browser ${Date.now()}`,
      scopes: ['portal-sessions:create', 'envelopes:read'],
      allowedReturnUrls: ['https://portal.homixliving.com/esign/return'],
    },
  });
  expect(clientResponse.status()).toBe(201);
  const client = (await clientResponse.json()).data;
  const launchResponse = await request.post('/v1/portal-sessions', {
    headers: { 'x-esign-key': client.credential },
    data: {
      actor: {
        subject: 'homix:browser-agent',
        email: 'browser-agent@homixliving.com',
        displayName: 'Browser Agent',
        role: 'preparer',
      },
      intent: { kind: 'dashboard' },
      returnUrl: 'https://portal.homixliving.com/esign/return',
    },
  });
  expect(launchResponse.status()).toBe(201);
  const launch = new URL((await launchResponse.json()).data.launchUrl);
  await page.goto(`${launch.pathname}${launch.hash}`);
  await expect(page.getByText(/via Homix Portal/i)).toBeVisible();
  await expect(page.getByLabel('Return to Homix Portal')).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain('esign_staff=');
  expect(await page.evaluate(() => document.cookie)).toContain('esign_staff_csrf=');
});

test('template author can upload a PDF, drag and resize a field, then publish', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Authoring interaction is exercised once.');
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([612, 792]);
  sheet.drawText('Synthetic browser-test agreement', { x: 72, y: 720, size: 18 });
  const bytes = await pdf.save();
  const templateName = `Browser authoring ${Date.now()}`;

  await page.goto('/templates');
  await page.getByRole('button', { name: 'Upload PDF', exact: true }).click();
  await page.getByLabel('PDF file').setInputFiles({
    name: 'synthetic-browser-form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  });
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Form/source name').fill('Synthetic Playwright fixture');
  await page.getByLabel('License owner').fill('Test fixtures only');
  await page.getByLabel('Edition').fill('2026.1');
  await page.getByLabel('Effective date').fill('2026-08-01');
  await page.getByRole('button', { name: 'Create draft' }).click();

  await expect(page.getByRole('heading', { name: templateName })).toBeVisible();
  await page.getByRole('heading', { name: templateName }).click();
  await expect(page.locator('.pdf-page')).toBeVisible();

  await page
    .getByRole('button', { name: 'Signature', exact: true })
    .dragTo(page.locator('.pdf-page'), { targetPosition: { x: 430, y: 300 } });
  const placed = page.locator('.placed-field');
  await expect(placed).toHaveCount(1);
  await expect(placed).toContainText('Signature');

  const before = await placed.boundingBox();
  const handle = page.locator('.resize-handle');
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 64, handleBox!.y + 30, { steps: 5 });
  await page.mouse.up();
  const after = await placed.boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft field map saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish version' }).click();
  await expect(page.getByText('Immutable template version published.')).toBeVisible();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
