// Cloudflare Email Worker: passes proof-of-payment emails sent to pop-<token>@jitsflow.com on to JitsFlow.
//
// One-time setup (Cloudflare dashboard, jitsflow.com):
//   1. Workers & Pages › Create › Worker › name it "jitsflow-pop" › Deploy, then Edit code: paste this file › Deploy.
//   2. That worker › Settings › Variables and Secrets › Add › type Secret, name INBOUND_SECRET, value: a long random string.
//      Put the same value in Render › jitsflow › Environment as INBOUND_SECRET.
//   3. Email › Email Routing › Routing rules › Catch-all address › Edit › Action: Send to a Worker › jitsflow-pop › Save.
//      (Your existing addresses, like hello@, keep their own rules; only unknown addresses reach the catch-all.)
// The server finds the gym from the address, reads the email and any PDF or image attached, and adds it to that gym's
// "To check" list. Nothing is marked paid until a coach confirms it.

export default {
  async email(message, env) {
    const to = String(message.to || "").toLowerCase();
    if (!/^pop-[a-z0-9]{6,32}@/.test(to)) { message.setReject("Unknown address"); return; }
    const res = await fetch(env.JITSFLOW_URL || "https://www.jitsflow.com/api/inbound/pop", {
      method: "POST",
      headers: { "content-type": "message/rfc822", "x-jf": "1", "x-jf-inbound": env.INBOUND_SECRET || "", "x-jf-to": to, "x-jf-from": String(message.from || "") },
      body: message.raw,
    });
    // An address that no longer exists bounces, so whoever forwards to it finds out. Server hiccups don't: the email is just dropped.
    if (res.status === 404) message.setReject("This JitsFlow forwarding address isn't in use any more.");
  },
};
