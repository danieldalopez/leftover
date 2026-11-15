// POST /api/demo/<action>: the demo control bar (spec §13). Only the allow-listed routes in
// lib/n8n.ts ACTIONS can be called; the browser never sees the webhook key or picks the body.
import { NextResponse } from 'next/server';
import { ACTIONS, runAction } from '@/lib/n8n';

export const maxDuration = 120; // the audit chain (LO-04 -> LO-05 -> LO-07) can take a while

export async function POST(_req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!(action in ACTIONS)) {
    return NextResponse.json({ ok: false, simulated: false, message: `Unknown action "${action}"` }, { status: 404 });
  }
  const result = await runAction(action);
  return NextResponse.json(result, { status: 200 });
}
