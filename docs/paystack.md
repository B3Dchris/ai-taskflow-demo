# Member card payments with Paystack

Members pay their gym by card, Apple Pay, Capitec Pay or EFT. Card payments go through JitsFlow's Paystack account: each gym's
bank account is a Paystack **subaccount**, so Paystack pays the gym's share straight into the gym's bank account (normally 2
working days after each payment). JitsFlow's 2% platform fee stays in JitsFlow's Paystack balance. JitsFlow never holds
membership money, and gyms don't need a Paystack account of their own. JitsFlow's own R99 gym plan stays on Payfast.

## Switching it on

Set these on the `jitsflow-app` service in Render (Environment), then redeploy:

| Variable | What it does |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Turns it all on. Start with the **test** key (`sk_test_…`, Paystack dashboard › Settings › API Keys & Webhooks), then swap in the **live** key (`sk_live_…`). Without it nothing about Paystack shows anywhere and gyms' own PayFast works as before. |
| `PAYSTACK_FEE_BEARER` | Optional. `subaccount` (default): the gym pays Paystack's processing fee from its share, as it did with Payfast. `account`: JitsFlow pays it. |
| `JF_PAYSTACK_LIVE` | Optional. `1` switches the public pages (pricing, terms, refunds, contact, secure payments, home, for-gyms) from "card payments coming soon" to "live". A live key does this by itself. |
| `JF_MEMBER_PAYMENTS` | Optional. `payfast` keeps members on their gyms' own PayFast even with a Paystack key set. Leave it unset. |

Then in the Paystack dashboard (Settings › API Keys & Webhooks), set the **Webhook URL** to:

    https://www.jitsflow.com/api/paystack/webhook

Set it for test mode and again for live mode (they're separate). The callback (where members come back after paying) is
handled automatically: `https://www.jitsflow.com/app/?paid=card`.

`JF_SECRET` must be set (it already is): it encrypts gyms' account and ID numbers and saved-card authorizations.

In test mode, payments are recorded as **TEST** (they don't count as paid), exactly like the PayFast sandbox. Only verify real gyms once
you're on the live key.

## A gym switches it on

1. The head coach opens **Money › Setup › Get paid by card** and enters: bank (Paystack's list), account number, account holder, the
   gym's registered business name, and the company registration number (or the owner's SA ID number for a sole owner).
2. JitsFlow creates (or updates) the gym's Paystack subaccount. The gym sees *"Waiting for JitsFlow to verify your bank account
   (usually within a day)"*, and the JitsFlow team gets an email.
3. You open the app › Me › **Dashboard**. Under **Card payouts to verify**, each gym shows its holder, bank, last 4 digits, KYC
   number (masked; **Show full numbers** shows them) and its subaccount code.
4. In Paystack: **Subaccounts** › find the code › check the bank, account number and name match the gym. Paystack holds the first
   payout to a new or changed subaccount until you verify it there, so do that now.
5. Back in JitsFlow, tap **Mark verified**. Card payments switch on for that gym straight away and the head coach is emailed.

If the gym changes its bank details later, it goes back to waiting (card payments pause) and you verify it again the same way.

## What members see

On the Pay sheet: **Apple Pay** (only on devices that can), **Card**, **Capitec Pay** and **EFT** (bank details and proof, as
before). Every card tile opens Paystack's checkout, which shows the methods Paystack offers on that device. Packs and plans can be
paid by card. **Save my card and pay automatically**: they pay what's due now (or a month's fees ahead) and Paystack keeps the
card; each month the autopay job charges exactly what's owed (same limits, failure emails, Stop and Undo as before).

Every payment is checked with Paystack (`/transaction/verify`) before it's recorded, for the amount, currency and gym subaccount
the checkout asked for. Anything that doesn't match isn't recorded and shows on the dashboard under **Needs attention**.

## Refunds

The head coach taps **Refund** on a card payment in **Money › Payments** (all of it or part). Paystack refunds it to the card; when
Paystack says it's done, it comes off what the member paid (a full refund puts their fees back to owing) and the head coach and
member are emailed. Paystack reverses the payment's split (the gym's share and JitsFlow's fee) under its own rules. A refund
Paystack can't make shows on the dashboard and the head coach is emailed.

## Chargebacks (disputes)

When a member disputes a payment with their bank, the payment is marked **Disputed**, and the head coach and the team are emailed
with Paystack's deadline. The head coach replies with their evidence (attendance, membership terms, messages); you answer in
Paystack › **Disputes** before the deadline, then tap **Done** on the dashboard. When Paystack resolves it, the head coach is told;
a lost dispute takes the payment off the member's balance.

## For developers

- `backend/paystack.js`: the API client and webhook signature check. Routes and settlement: the Paystack section of `backend/api.js`.
- Endpoints: `GET/PUT /api/coach/paystack`, `GET /api/coach/paystack/banks`, `POST /api/me/pay/paystack`,
  `POST /api/me/pay/paystack/check`, `POST /api/me/autopay` (Paystack when on), `POST /api/coach/payments/:id/refund`,
  `POST /api/paystack/webhook`, `POST /api/admin/paystack/gyms/:id/{verify,disable,reveal}`, `POST /api/admin/paystack/{dispute,refund}/:id/seen`.
- Tables: `gyms.paystack`, `paystack_checkouts`, `paystack_refunds`, `paystack_disputes`; `payments.fee_cents`, `psp_fee_cents`,
  `refunded_cents`, `dispute`; `autopay.provider`, `pay_email`, `card_label`.
- Tests: `node tests/paystack.js` and `node tests/paystack-ui.js` (with a test `DATABASE_URL`) run against a local stand-in for
  Paystack (`tests/fake-paystack.js`); nothing contacts Paystack.
