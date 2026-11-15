// GET /api/data/<summary|audits|portfolio|projection|settings>: the same data the pages render,
// for debugging and for scripts. Read-only; the n8n key stays on the server.
import { NextResponse } from 'next/server';
import { getAudits, getPortfolio, getProjection, getSettings, getSummary } from '@/lib/n8n';

export async function GET(req: Request, ctx: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = await ctx.params;
  const q = new URL(req.url).searchParams;
  switch (endpoint) {
    case 'summary':
      return NextResponse.json(await getSummary());
    case 'audits':
      return NextResponse.json(await getAudits());
    case 'portfolio':
      return NextResponse.json(await getPortfolio(q.get('fixture') === 'queued' ? 'queued' : 'default'));
    case 'projection':
      return NextResponse.json(await getProjection(q.get('rate') ?? '0.06'));
    case 'settings':
      return NextResponse.json(await getSettings());
    default:
      return NextResponse.json({ ok: false, error: { code: 'NOT_FOUND', message: `no endpoint ${endpoint}` } }, { status: 404 });
  }
}
