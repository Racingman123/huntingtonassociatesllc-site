export async function GET() {
  return Response.json({ status: "ok", service: "giveaway-template", timestamp: new Date().toISOString() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
