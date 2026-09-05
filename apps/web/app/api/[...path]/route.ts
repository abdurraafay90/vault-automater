import { type NextRequest, NextResponse } from 'next/server';

const BACKEND_URL =
  process.env.BACKEND_API_URL ||
  process.env.INTERNAL_API_URL ||
  'http://127.0.0.1:4000';

async function handleProxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const targetPath = `/api/${(path || []).join('/')}`;
  const url = new URL(req.url);
  const targetUrl = `${BACKEND_URL}${targetPath}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((val, key) => {
    const lower = key.toLowerCase();
    if (
      lower !== 'host' &&
      lower !== 'connection' &&
      lower !== 'expect' &&
      lower !== 'content-length' &&
      lower !== 'transfer-encoding'
    ) {
      headers.set(key, val);
    }
  });

  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await req.arrayBuffer() : undefined;


  try {
    const backendRes = await fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-expect-error duplex required for streaming in some node versions
      duplex: 'half',
      redirect: 'manual',
    });

    const resHeaders = new Headers();
    backendRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (lower !== 'content-encoding' && lower !== 'transfer-encoding' && lower !== 'content-length' && lower !== 'set-cookie') {
        resHeaders.set(key, val);
      }
    });

    const resBuffer = await backendRes.arrayBuffer();
    const response = new NextResponse(resBuffer, {
      status: backendRes.status,
      statusText: backendRes.statusText,
      headers: resHeaders,
    });

    const setCookies = typeof backendRes.headers.getSetCookie === 'function'
      ? backendRes.headers.getSetCookie()
      : [backendRes.headers.get('set-cookie')].filter(Boolean) as string[];

    for (const cookieStr of setCookies) {
      response.headers.append('set-cookie', cookieStr);
    }

    return response;

  } catch (error) {
    console.error(`[API Proxy Error] Failed to proxy to ${targetUrl}:`, error);
    return NextResponse.json(
      { code: 'GATEWAY_ERROR', message: 'Failed to connect to backend API server.' },
      { status: 502 }
    );
  }
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const PATCH = handleProxy;
export const DELETE = handleProxy;
export const HEAD = handleProxy;
export const OPTIONS = handleProxy;
