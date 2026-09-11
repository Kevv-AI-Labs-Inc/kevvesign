import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import type { Envelope, Template, TemplateField, TemplateDocument } from '@esign/contracts';

test('two recipients sign two PDFs with explicit adoption, saved ink, and Chinese text', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText('Synthetic customer signing test - not a real agreement', {
    x: 40,
    y: 735,
    size: 14,
  });
  const bytes = Buffer.from(await pdf.save());
  const upload = await request.post('/v1/templates', {
    multipart: {
      metadata: JSON.stringify({
        name: `Client signing ${testInfo.project.name} ${Date.now()}`,
        sourceName: 'Synthetic QA form',
        licenseOwner: 'QA fixture only',
        edition: '1',
        effectiveDate: '2026-09-11',
        jurisdiction: 'NY',
        businessDomain: 'REAL_ESTATE',
        approvalRequired: false,
        retentionPolicyId: 'real-estate-7y',
      }),
      file: { name: 'listing-qa.pdf', mimeType: 'application/pdf', buffer: bytes },
    },
  });
  expect(upload.status()).toBe(201);
  const template: Template = (await upload.json()).data;
  const draft = template.versions[0]!;
  const second = await request.post(`/v1/templates/${template.id}/versions/${draft.id}/documents`, {
    multipart: { file: { name: 'buyer-qa.pdf', mimeType: 'application/pdf', buffer: bytes } },
  });
  expect(second.status()).toBe(201);
  const documents: TemplateDocument[] = [draft.documents[0]!, (await second.json()).data];
  const roles = [
    draft.roles[0]!,
    { id: crypto.randomUUID(), name: 'Co-buyer', kind: 'countersigner' as const, routingOrder: 2 },
  ];
  const fields: TemplateField[] = roles.flatMap((role, recipient) =>
    documents.flatMap((document, doc) =>
      (['signature', 'signed_date', 'checkbox'] as const).map((type, index) => ({
        id: crypto.randomUUID(),
        documentId: document.id,
        page: 1,
        type,
        roleId: role.id,
        label: `${type} ${recipient + 1}-${doc + 1}`,
        required: true,
        readOnly: false,
        sensitive: false,
        tabIndex: recipient * 6 + doc * 3 + index,
        rect: {
          x: 0.12,
          y: 0.15 + recipient * 0.35 + index * 0.1,
          width: type === 'checkbox' ? 0.06 : 0.5,
          height: 0.06,
          rotation: 0 as const,
        },
      })),
    ),
  );
  expect(
    (
      await request.patch(`/v1/templates/${template.id}/versions/${draft.id}`, {
        data: { roles, fields },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await request.post(`/v1/templates/${template.id}/versions/${draft.id}/publish`)).status(),
  ).toBe(200);
  const create = await request.post('/v1/envelopes', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      templateId: template.id,
      subject: '客户签署测试 — Listing 与 Buyer',
      message: 'Synthetic test only.',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      recipients: roles.map((role, index) => ({
        roleId: role.id,
        name: index ? '张买家' : '测试客户',
        email: `qa-buyer-${index}@example.invalid`,
      })),
    },
  });
  expect(create.status()).toBe(201);
  const envelope: Envelope = (await create.json()).data;
  const send = await request.post(`/v1/envelopes/${envelope.id}/send`, {
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(send.status()).toBe(200);
  const invitation = new URL((await send.json()).data.invitationUrls[0]);
  await page.goto(invitation.pathname);
  await page.getByRole('button', { name: 'I agree and want to continue' }).click();
  await page.getByRole('button', { name: 'signature 1-1', exact: true }).click();
  const adopt = page.getByRole('button', { name: 'Adopt signature', exact: true });
  const intent = page.getByRole('checkbox', { name: /I intend this electronic mark/ });
  await expect(intent).not.toBeChecked();
  await expect(adopt).toBeDisabled();
  await intent.check();
  await expect(adopt).toBeEnabled();
  await intent.uncheck();
  await expect(adopt).toBeDisabled();
  await intent.check();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(adopt).toBeDisabled();
  const canvas = page.locator('.draw-signature canvas');
  async function draw() {
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 70, { steps: 8 });
    await page.mouse.move(box.x + 120, box.y + 30, { steps: 8 });
    await page.mouse.up();
  }
  await draw();
  await expect(adopt).toBeEnabled();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(adopt).toBeDisabled();
  await draw();
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(adopt).toBeDisabled();
  await draw();
  await adopt.click();
  for (const field of fields.filter(
    (field) => field.roleId === roles[0]!.id && field.type !== 'signature',
  )) {
    if (field.type === 'checkbox') await page.getByRole('checkbox', { name: field.label }).check();
    else await page.getByRole('button', { name: field.label }).click();
  }
  await page.getByRole('button', { name: 'Save progress', exact: true }).click();
  await expect(page.getByText('Progress saved securely.')).toBeVisible();
  await page.reload();
  await expect(page.locator('.type-signature')).toContainText(['Signed ✓', 'Signed ✓']);
  await page.getByRole('button', { name: 'Adopt & finish' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you. You’re finished.' })).toBeVisible();
  const halfway: Envelope = (await (await request.get(`/v1/envelopes/${envelope.id}`)).json()).data;
  expect(halfway.recipients[0]!.status).toBe('COMPLETED');
  expect(halfway.recipients[1]!.status).toBe('ACTIVE');
  const resend = await request.post(
    `/v1/envelopes/${envelope.id}/recipients/${halfway.recipients[1]!.id}/resend`,
  );
  expect(resend.status()).toBe(200);
  await page.goto(new URL((await resend.json()).data.invitationUrl).pathname);
  await page.getByRole('button', { name: 'I agree and want to continue' }).click();
  await page.getByRole('button', { name: 'signature 2-1', exact: true }).click();
  await page.getByRole('checkbox', { name: /I intend this electronic mark/ }).check();
  await page.getByRole('button', { name: 'Adopt signature', exact: true }).click();
  for (const field of fields.filter(
    (field) => field.roleId === roles[1]!.id && field.type !== 'signature',
  )) {
    if (field.type === 'checkbox') await page.getByRole('checkbox', { name: field.label }).check();
    else await page.getByRole('button', { name: field.label }).click();
  }
  await page.getByRole('button', { name: 'Adopt & finish' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you. You’re finished.' })).toBeVisible();
  const completed: Envelope = (await (await request.get(`/v1/envelopes/${envelope.id}`)).json())
    .data;
  expect(completed.status).toBe('COMPLETED');
  for (const field of fields.filter((field) => field.type === 'signed_date')) {
    const recipient = completed.recipients.find((item) => item.roleId === field.roleId)!;
    expect(recipient.values[field.id]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  const evidence = await request.get(`/v1/envelopes/${envelope.id}/evidence`);
  expect((await evidence.json()).data.verificationStatus).toBe('VERIFIED');
  for (const document of documents) {
    const download = await request.get(`/v1/envelopes/${envelope.id}/evidence/${document.name}`);
    expect(download.status()).toBe(200);
    const bytes = await download.body();
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    expect(bytes.toString('latin1')).toContain('/Subtype /Image');
    await testInfo.attach(document.name, { body: bytes, contentType: 'application/pdf' });
  }
  await testInfo.attach('completed', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});
