import { expect, test } from '@playwright/test';

test.describe('THE VOID — Real Multi-Browser End-to-End Verification', () => {
  test('complete multi-visitor world flow: creation, realtime sync, CSS styling, sandbox fault isolation, archaeology copy, deletion, deep links, and persistence', async ({
    browser
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // 1. Both visitors enter the world immediately with no login or landing page
    await Promise.all([pageA.goto('/'), pageB.goto('/')]);

    await expect(pageA.getByTestId('void-world-shell')).toBeVisible();
    await expect(pageA.getByTestId('hud-connection-status')).toHaveText('online');
    await expect(pageB.getByTestId('hud-connection-status')).toHaveText('online');

    // 2. Visitor A creates a programmable object and writes <h1>HELLO</h1>
    await pageA.getByTestId('hud-create-btn').click();
    await expect(pageA.getByTestId('inspector-panel')).toBeVisible();

    const htmlEditorA = pageA.getByTestId('code-editor-html');
    await htmlEditorA.fill('<h1>HELLO</h1>');
    await pageA.getByTestId('inspector-run-btn').click();

    await expect(pageA.getByTestId('inspector-object-revision')).toHaveText('r2');

    // Extract the created object ID from the DOM
    const objectCardA = pageA.locator('[data-testid^="world-object-"]').first();
    await expect(objectCardA).toBeVisible();
    const objectId = await objectCardA.getAttribute('data-object-id');
    expect(objectId).toBeTruthy();

    // 3. Visitor B sees the created object in realtime and modifies HTML to <h1>GOODBYE</h1>
    const objectCardB = pageB.getByTestId(`world-object-${objectId}`);
    await expect(objectCardB).toBeVisible();

    await pageB.getByTestId(`inspect-btn-${objectId}`).click();
    await expect(pageB.getByTestId('inspector-panel')).toBeVisible();
    await expect(pageB.getByTestId('code-editor-html')).toHaveValue('<h1>HELLO</h1>');

    await pageB.getByTestId('code-editor-html').fill('<h1>GOODBYE</h1>');
    await pageB.getByTestId('inspector-run-btn').click();
    await expect(pageB.getByTestId('inspector-object-revision')).toHaveText('r3');

    // Visitor A receives the update in realtime
    await expect(pageA.getByTestId('inspector-object-revision')).toHaveText('r3');
    await expect(pageA.getByTestId('code-editor-html')).toHaveValue('<h1>GOODBYE</h1>');

    // 4. Visitor B adds CSS spin animation
    await pageB.getByTestId('tab-css').click();
    const spinCss = 'h1 { animation: spin 1s infinite; color: rgb(200, 162, 78); }';
    await pageB.getByTestId('code-editor-css').fill(spinCss);
    await pageB.getByTestId('inspector-run-btn').click();
    await expect(pageB.getByTestId('inspector-object-revision')).toHaveText('r4');
    await expect(pageA.getByTestId('inspector-object-revision')).toHaveText('r4');

    // 5. Sandbox isolation & Failure isolation:
    // Visitor B introduces broken JS (accessing parent window + undefined variable + infinite loop)
    await pageB.getByTestId('tab-javascript').click();
    await pageB
      .getByTestId('code-editor-javascript')
      .fill('try { window.parent.document.body.innerHTML = "pwned"; } catch (e) {}\nundefinedVariable.foo();');
    await pageB.getByTestId('inspector-run-btn').click();
    await expect(pageB.getByTestId('inspector-object-revision')).toHaveText('r5');

    // Verify parent application was NOT compromised and local FAULT badge appears on the object
    await expect(pageA.getByTestId('void-world-shell')).toBeVisible();
    await expect(pageA.getByTestId(`object-fault-badge-${objectId}`)).toBeVisible();
    await expect(pageB.getByTestId(`object-fault-badge-${objectId}`)).toBeVisible();

    // Also test infinite loop isolation (`while (true) {}`)
    await pageB.getByTestId('code-editor-javascript').fill('while (true) {}');
    await pageB.getByTestId('inspector-run-btn').click();
    await expect(pageB.getByTestId('inspector-object-revision')).toHaveText('r6');
    await expect(pageB.getByTestId(`object-fault-badge-${objectId}`)).toBeVisible();
    await expect(pageB.getByTestId(`object-fault-banner-${objectId}`)).toContainText(/Execution timeout/i);

    // 6. History Archaeology: Visitor A inspects history, verifies no restore button exists, and spawns an independent copy from r4
    await pageA.getByTestId('tab-history').click();
    await expect(pageA.getByTestId('history-pane')).toBeVisible();
    await expect(pageA.locator('button:has-text("restore")')).toHaveCount(0);
    await expect(pageA.locator('button:has-text("rollback")')).toHaveCount(0);

    await pageA.getByTestId('revision-item-4').click();
    await expect(pageA.getByTestId('history-detail-html')).toHaveText('<h1>GOODBYE</h1>');
    await expect(pageA.getByTestId('history-detail-css')).toHaveText(spinCss);

    await pageA.getByTestId('history-spawn-copy-btn').click();

    // Now there are 2 objects in the world!
    await expect(pageA.locator('[data-testid^="world-object-"]')).toHaveCount(2);
    await expect(pageB.locator('[data-testid^="world-object-"]')).toHaveCount(2);

    // Find the new independent copy ID
    const allIds = await pageA
      .locator('[data-testid^="world-object-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-object-id')));
    const copyId = allIds.find((id) => id && id !== objectId)!;
    expect(copyId).toBeTruthy();

    // 7. Deletion: Visitor B deletes the original broken object; it disappears for both visitors while the independent copy remains
    await pageB.getByTestId(`delete-btn-${objectId}`).click();

    await expect(pageA.getByTestId(`world-object-${objectId}`)).toHaveCount(0);
    await expect(pageB.getByTestId(`world-object-${objectId}`)).toHaveCount(0);
    await expect(pageA.getByTestId(`world-object-${copyId}`)).toBeVisible();
    await expect(pageB.getByTestId(`world-object-${copyId}`)).toBeVisible();

    // 8. Navigation & Deep Links: Navigate far away (50000, -50000) and return via deep link
    await pageA.getByTestId('coord-input-x').fill('50000');
    await pageA.getByTestId('coord-input-y').fill('-50000');
    await pageA.getByTestId('coord-jump-btn').click();

    // Far away at (50000, -50000), the origin object is unloaded from view
    await expect(pageA.getByTestId('hud-object-count')).toHaveText('0 in view');

    // Return to origin via 0,0 button
    await pageA.getByTestId('origin-jump-btn').click();
    await expect(pageA.getByTestId(`world-object-${copyId}`)).toBeVisible();

    // 9. Browser refresh persistence: Reload pageA and verify the independent copy persists
    await pageA.reload();
    await expect(pageA.getByTestId(`world-object-${copyId}`)).toBeVisible();
    await expect(pageA.getByTestId(`world-object-${objectId}`)).toHaveCount(0);

    // Open deep link directly to the copied object
    await pageB.goto(`/?x=60&y=60&zoom=1.2&object=${copyId}`);
    await expect(pageB.getByTestId('inspector-panel')).toBeVisible();
    await expect(pageB.getByTestId('code-editor-html')).toHaveValue('<h1>GOODBYE</h1>');

    await contextA.close();
    await contextB.close();
  });
});
