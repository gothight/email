import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('Email Worker', () => {
	it('renderiza la página de inicio (unit)', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const text = await response.text();
		expect(text).toContain('Email Worker - D1 Storage');
	});

	it('renderiza la página de inicio (integration)', async () => {
		const response = await SELF.fetch('http://example.com');
		const text = await response.text();
		expect(text).toContain('Email Worker - D1 Storage');
	});
});
