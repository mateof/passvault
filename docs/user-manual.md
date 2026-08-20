# PassVault user manual

This manual is written for the person using PassVault, not for the person building
it. It explains what the app and the web interface can do and — for the parts that
are hard to find — exactly where to click.

PassVault keeps event tickets. The usual story: you buy ten tickets to a concert in
one PDF, and you have to split them between friends, know who has paid, and make sure
each person carries their own on their phone — without depending on there being any
signal at the door.

Two ways in, sharing one server:

- **The web interface**, served by the server itself at its own address. Best for the
  work you do sitting down: importing a PDF, handing tickets out, deciding who pays.
- **The Android app**, which is offline-first. Best for carrying a ticket to the gate,
  and for handing one to somebody stood next to you when there is no signal.

Throughout, two roles matter:

- The **creator** of an event owns it. They import the tickets, hand them out, decide
  who may see each barcode and when, and record who has paid.
- A **holder** has been given one seat. They can see their own barcode (once the
  creator allows it) and nobody else's, and they can hand a seat back while they still
  have not seen its code.

---

## 1. Accounts and the vault passphrase

Your login (email plus one of the four sign-in methods, or a passkey) proves who you
are to the server. Separately, a **vault passphrase** encrypts your tickets. These are
deliberately two different secrets: the server can reset how you log in without ever
being able to read your tickets, because it never holds the passphrase.

You are asked for the vault passphrase when you first open your tickets on a device and
whenever that device has forgotten it. Losing it means losing the ability to decrypt
what is stored on that device; it is not something the server can recover for you.

---

## 2. Creating an event and importing tickets

1. Create the event and give it a name.
2. Import the tickets. PassVault reads barcodes out of a PDF, an image, or a `.pkpass`
   file. A PDF with several tickets is **proposed, not imported blindly**: you see a
   review screen with one row per barcode found, an instructions cover page is
   unticked for you, and you can tick or untick rows before saving. This is on purpose
   — a PDF might put two passes on one page, or lead with a page of directions.

   When a page does hold several passes, PassVault cuts it up along the blank gutter
   between them: each ticket keeps its own pass whole — reference, price and all — and
   nothing of its neighbour, so handing a seat to somebody does not hand them the codes
   printed beside it. If the layout cannot be divided — codes overlapping, or
   interleaved — the review screen says so, and every ticket off that page carries the
   whole sheet. A page with more codes than PassVault will read at once says that too,
   rather than quietly proposing a short list.

   Two passes on one sheet sometimes carry the **same** code: several Spanish sellers
   issue one code per order and print it on every ticket, and what tells the tickets
   apart is the reference and the type. Both are proposed, with a note asking you to
   check, because they may equally be a ticket and its stub. A code repeated on a
   *different* page is another matter — that is usually a summary sheet — and it is
   unticked for you.

Every imported ticket carries its barcode. From here on, the creator decides who gets
which seat and who may see its code.

When you open a ticket you hold, the code is drawn as the symbol a scanner reads, not
written out as text, so the screen works at a turnstile. Beside it is **Show the pass**:
the part of the sheet that is yours, with your reference, type and price on it — which is
what tells one ticket from another when a seller prints the same code on every ticket of
an order. Opening the pass counts as having seen the code, because the code is printed on
it, so the same rules apply as to the code itself.

---

## 3. Handing tickets out

A creator has two ways to give a seat away, and they are not the same thing:

- **Assign a holder label** (a name written on the ticket). This is a note to yourself.
  It does *not* let that person see the barcode.
- **Assign to an account, by address.** This is giving the ticket to somebody. An
  assigned holder with an account is the only person — other than the creator — who can
  see the barcode of *their own* ticket, and of no one else's.

  On the web: open a ticket (click its row to expand it) and use **"Assign to
  account"** with the person's address.

You can also share a whole event with a **group** so that its members receive tickets
together. Groups are managed from the app's and the web's group screens.

Only the creator may share an event or its tickets. A member cannot pass a seat on
unless the creator has permitted that seat to be shared (see §5).

---

## 4. Payments — who has paid, and who may know

The creator records who has paid and chooses who may see that.

### As the creator

**On the web:** open the ticket (click its row to expand it). Below the barcode area
you will find the **payment form**, where you set:

- the **state**: Unpaid, Part paid, Paid, or Waived;
- optionally an **amount** and currency;
- the **visibility**: who may see the payment —
  - **Everyone** — every member of the event sees it;
  - **Only the holder** — only that seat's holder (and you) sees it;
  - **Only the creator** — only you see it.

**In the app:** open the ticket and scroll down to the creator controls. The first
section is **Payment**: a button that toggles the seat between Paid and Unpaid, and
three choices for who may see it (all members / only the holder / only you).

### As a member

You see a payment line on a ticket **only when the creator has chosen to show it to
you** — for your own debt, or for everybody's, depending on the visibility they set. If
you see nothing, the creator has kept it private. The rule is enforced on the server:
the payment figure is never sent to a device that is not allowed to see it, so hiding
it is real, not just a blank on screen.

### Payment can gate the barcode

An unpaid seat can be kept locked: its barcode does not appear until the creator marks
it paid. That is the link between this section and the next one.

---

## 5. Controlling when a barcode appears

This is the part that is easy to miss. **The controls live inside an expanded ticket,
not on the event screen.**

The idea: a barcode is a token to the bearer. Once somebody has seen it they can
photograph it, so the creator may want to withhold it until close to the event — long
enough for the holder to hand it back if plans change, but not so early that it can be
copied and passed around.

### Where the controls are

**On the web:** open the event, then **click a ticket's row to expand it**. Below the
barcode and the payment form is a block titled with an explanation of visibility, and
under it every control described here.

**In the app:** open the ticket (tap it in the wallet). If you are the creator,
**scroll down past the barcode** — the creator controls are at the bottom of the
screen.

### What each control does

- **Visible from (date and time).** Set an exact moment the code opens. Until then the
  holder sees "the code becomes visible in …" with a live countdown, and the barcode is
  withheld.
- **Open the day before the event.** The common case as one tap: the code opens 24
  hours before the event starts.
- **No time limit / clear.** Removes any schedule; the code is governed only by
  blocking and payment.
- **Block the code.** Withholds it immediately. Use this to pull a code back before the
  event. **Important:** blocking is refused once the holder has already seen the code —
  at that point they may have a photograph, and the interface will not pretend
  otherwise. The button says so rather than failing when pressed.
- **Unblock.** Hand the code back to the holder at any time.
- **Let the holder share it.** A switch. Off by default: a member cannot pass their
  seat to another phone. Turn it on to permit that one seat to be shared on.

All times are measured against the **server's clock**, shown under the controls on the
web. Moving your phone's or computer's clock does nothing.

### What the holder sees while a code is withheld

The holder's ticket shows *that they have it* and why it is not yet visible — waiting
for a time (with the countdown), unpaid, or held by the organiser — rather than showing
nothing. If it is waiting for a time, a live countdown ticks down to the moment it
opens.

A note on the difference between web and app, told honestly: on the **web** the barcode
is withheld by the server, which simply does not send it until it is due. In the
**app**, which is offline-first, the code already lives on the phone from when the
ticket arrived; the app honours the lock and does not display it, and asks the server
whether each code is due. The app's enforcement is therefore the app keeping its word,
not a server refusing to hand the code over. For a code that must be genuinely
unavailable until its moment, the web is the stronger guarantee.

---

## 6. Returning a seat

A holder can hand a seat back **while they still have not seen its code** — a locked
ticket is nobody's loss to give up, but once the code has been shown it cannot be
returned (they may already have a copy).

- **On the web:** on a locked ticket you have not revealed, a **return** button appears
  in the expanded ticket.
- **In the app:** open the locked ticket; the **return** action is on the ticket
  screen, under the lock notice.

Once returned, the seat goes back to the event for the creator to hand out again.

---

## 7. Handing a ticket to the phone next to you

Two phones can exchange tickets directly, with no signal, either over an **NFC tap** or
over the **local Wi-Fi**. Being on the same network authenticates nobody, so the two
phones show a **six-digit code** derived from the exchange: read it aloud and check it
matches on both screens before anything transfers. If it matches, there is no phone in
the middle.

When you send, you can **choose whether the original files travel too** — the PDF or
image a ticket was split out of — and, if there are several, **which ones**. Sometimes
you want only the seat; sometimes you want the whole document that came with it.

Remember §5: only the creator can share by default. A member can send a seat on only if
the creator turned on "let the holder share it" for that seat.

---

## 8. Sessions, sign-in methods, and leaving

- **Staying signed in.** A session refreshes itself in the background and lasts as long
  as the administrator has set; you are not asked to log in every time. Each session
  records the device it came from, so you can see and end them.
- **Several authenticators.** An account can hold more than one passkey or second
  factor, so losing one device does not lock you out. Manage them from your profile.
- **Deleting your account** is available to you from your profile, and to an
  administrator. Deleting an account or an event withdraws the relevant tickets, and the
  withdrawal reaches the phones on their next sync.

---

## 9. The security limits, said plainly

A ticket is a **bearer token**: its value is a barcode the gate reads without asking
anyone. Three consequences follow, and PassVault does not pretend otherwise:

1. **There is no true revocation of a code already seen.** Once someone has viewed a
   barcode, they may have photographed it. Withholding, blocking and the reveal-once
   rules exist to keep that window small — not to take a code back after it has been
   shown.
2. **Assignment is a social agreement, not a technical guarantee.** Two people can turn
   up with the same barcode; the gate admits the first.
3. **The realistic goal** is to prevent mistakes, leave a trail, and keep the exposure
   window short — not to make duplication impossible.

This is why the withholding and countdown machinery matters: the smaller the window
between a code being revealed and the event, the less a bearer token can be abused.
