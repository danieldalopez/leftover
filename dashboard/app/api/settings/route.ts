// POST /api/settings: proxies to POST /lo/api/settings with the demo user's id.
import { NextResponse } from 'next/server';
import { cleanSettings, saveSettings } from '@/lib/n8n';

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, simulated: false, message: 'Body must be JSON' }, { status: 400 });
  }
  const result = await saveSettings(cleanSettings(body));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
