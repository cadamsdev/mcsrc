import { expect, test } from '@playwright/test';
import fs from 'fs';
import { waitForDecompiledContent, setupTest } from './test-utils';

test.describe('Decompilation', () => {
    test.beforeEach(async ({ page }) => {
        await setupTest(page);
    });

    test('Decompiles default class on initial load', async ({ page }) => {
        await page.goto('/');
        await page.getByText('ChatFormatting', { exact: true }).click();
        await waitForDecompiledContent(page, 'enum ChatFormatting');
    });

    test('Decompile many classes', async ({ page }) => {
        await page.goto('/');
        await page.getByText('ChatFormatting', { exact: true }).click();
        await waitForDecompiledContent(page, 'enum ChatFormatting');

        const modalButton = page.getByTestId('jar-decompiler').first();
        await modalButton.waitFor();
        await modalButton.click();

        const splitsInput = page.getByTestId('jar-decompiler-splits').first();
        await splitsInput.waitFor();
        await splitsInput.fill('1');

        const okButton = page.getByTestId('jar-decompiler-ok').first();
        await okButton.waitFor();
        await okButton.click();

        const result = page.getByTestId('jar-decompiler-result').first();
        await result.waitFor();
        await expect(result).toContainText(/Decompiled [1-9][0-9]* new classes in/);
    });

    test('Download all decompiled source as a ZIP', async ({ page }) => {
        await page.goto('/');
        await page.getByText('ChatFormatting', { exact: true }).click();
        await waitForDecompiledContent(page, 'enum ChatFormatting');

        const downloadButton = page.getByTestId('download-source').first();
        await downloadButton.waitFor();
        await downloadButton.click();

        const okButton = page.getByTestId('download-source-ok').first();
        await okButton.waitFor();

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            okButton.click(),
        ]);

        expect(download.suggestedFilename()).toMatch(/-source\.zip$/);

        const path = await download.path();
        expect(path).toBeTruthy();
        const stats = fs.statSync(path!);
        expect(stats.size).toBeGreaterThan(0);
    });
});
