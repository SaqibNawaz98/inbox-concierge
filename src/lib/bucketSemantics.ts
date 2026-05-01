import type { BucketName, EmailThread } from "@/lib/types";

/** Receipts / proof-of-purchase style bucket names (includes common typo "Reciepts"). */
export function bucketUsesPostReceiptSemantics(bucket: string): boolean {
  const k = bucket.trim().toLowerCase();
  return /^receipts?$/.test(k) || k === "reciepts" || k === "reciept";
}

/** Outstanding / payable invoice style bucket names. */
export function bucketUsesBillsSemantics(bucket: string): boolean {
  const k = bucket.trim().toLowerCase();
  return /^bills?$/.test(k) || /^billing$/.test(k);
}

/** Strict transactional bucket (either side of pay vs proof). */
export function bucketUsesReceiptSemantics(bucket: string): boolean {
  return bucketUsesPostReceiptSemantics(bucket) || bucketUsesBillsSemantics(bucket);
}

/** Bucket labels that must never use loose substring matching against the bucket name. */
export function bucketUsesStrictSemantics(bucket: string): boolean {
  const trimmed = bucket.trim().toLowerCase();
  return (
    /^jobs?$/.test(trimmed) ||
    /^job\s*hunt(ing)?$/.test(trimmed) ||
    bucketUsesReceiptSemantics(trimmed)
  );
}

const TRANSACTIONAL_PROMO_BLOCK = [
  /\b(email only sale|subscriber(s)? only|%\s*off|preview:?)\b/i,
  /\bnewsletter\b/i,
];

/** Paid / settled cues — unpaid matcher should bail. */
const OUTSTANDING_BILLS_PAID_NEGATIVE = [
  /\bthank\s+you\s+for\s+(your\s+)?payment\b/i,
  /\bpayment\s+(was\s+)?(received|processed|successful|confirmed|captured)\b/i,
  /\bpaid\s+in\s+full\b/i,
  /\bpayment\s+received\b/i,
  /\bpaid\s+your\s+invoice\b/i,
  /\binvoice\s+(is\s+|has\s+been\s+)?(paid|settled|covered)\b/i,
];

/** Unpaid cues — receipts matcher should defer to Bills when Bills exists. */
const POST_RECEIPT_UNPAID_LEAK_NEGATIVE = [
  /\b(amount|balance)\s+due\b/i,
  /\bpayment\s+due\b/i,
  /\bpayment\s+(is\s+)?required\b/i,
  /\boutstanding\s+(balance|invoice|amount)\b/i,
  /\bplease\s+(pay|remit)\b/i,
  /\b(unpaid|overdue)\b/i,
  /\bpay\s+(by|before)\b/i,
  /\bill\s+(is\s+)?due\b/i,
  /\blink\s+(to\s+)?pay\b/i,
];

/** Ask for settlement / owes money. */
const OUTSTANDING_BILLS_POSITIVE = [
  /\b(amount|balance)\s+due\b/i,
  /\bpayment\s+due\b/i,
  /\boutstanding\s+(balance|invoice|amount|charges?)\b/i,
  /\bplease\s+(pay|remit|complete\s+(your\s+)?payment)\b/i,
  /\bcomplete\s+(your\s+)?payment\b/i,
  /\bpay\s+(your\s+)?invoice\b/i,
  /\boverdue\b/i,
  /\bunpaid\b/i,
  /\bnew\s+invoice\b/i,
  /\binvoice\s+reminder\b/i,
  /\bpay\s+this\s+(invoice|bill)\b/i,
  /\bpay\s+your\s+bill\b/i,
  /\byour\s+bill\s+is\s+ready\b/i,
  /\byour\s+payment\s+is\s+past\s+due\b/i,
  /\b(electric|gas|internet|utilities)\s+(bill|statement)\b/i,
];

/** Completed purchase / fulfillment line — proof side. */
const POST_TRANSACTION_RECEIPTS_POSITIVE = [
  /\breceipt\b/i,
  /\border\s+(#|confirmation|number)\b/i,
  /\b(your\s+)?order\s+(has\s+been\s+)?(shipped|delivered|confirmed)\b/i,
  /\bshipping\s+(confirmation|notification)\b/i,
  /\b(out\s+for\s+delivery|package\s+delivered)\b/i,
  /\bpayment\s+(received|confirmed|successful)\b/i,
  /\bthank\s+you\s+for\s+(your\s+)?(purchase|order)\b/i,
  /\bproof\s+of\s+purchase\b/i,
  /\btransaction\s+(complete|successful)\b/i,
  /\brefund\s+(has\s+been\s+)?(processed|issued|completed)\b/i,
];

function transactionalBaseText(thread: EmailThread): string {
  return `${thread.subject}\n${thread.preview}\n${thread.sender}`;
}

/** Outstanding invoices / payable notices (not receipts after payment clears). */
export function semanticOutstandingBillsMatch(thread: EmailThread): boolean {
  const text = transactionalBaseText(thread);
  if (TRANSACTIONAL_PROMO_BLOCK.some((pattern) => pattern.test(text))) {
    return false;
  }
  if (OUTSTANDING_BILLS_PAID_NEGATIVE.some((pattern) => pattern.test(text))) {
    return false;
  }
  return OUTSTANDING_BILLS_POSITIVE.some((pattern) => pattern.test(text));
}

/** Post-payment confirmations, proofs, fulfilment notices. When Bills sibling exists, exclude unpaid leakage. */
export function semanticPostTransactionReceiptMatch(thread: EmailThread): boolean {
  const text = transactionalBaseText(thread);
  if (TRANSACTIONAL_PROMO_BLOCK.some((pattern) => pattern.test(text))) {
    return false;
  }
  return (
    POST_TRANSACTION_RECEIPTS_POSITIVE.some((pattern) => pattern.test(text)) &&
    !POST_RECEIPT_UNPAID_LEAK_NEGATIVE.some((pattern) => pattern.test(text))
  );
}

/**
 * Convenience: catches either unpaid or settled transactional mail (fallback / tooling).
 * For routing, prefer {@link semanticOutstandingBillsMatch} vs {@link semanticPostTransactionReceiptMatch}.
 */
export function semanticReceiptsMatch(thread: EmailThread): boolean {
  return semanticOutstandingBillsMatch(thread) || semanticPostTransactionReceiptMatch(thread);
}

/** Whether strict rules say this transactional bucket accepts the thread given sibling bucket names. */
export function transactionalMoneyBucketMatches(
  thread: EmailThread,
  bucket: BucketName,
  transactionalPeers: BucketName[],
): boolean {
  if (!bucketUsesReceiptSemantics(bucket)) {
    return false;
  }

  const hasReceipt = transactionalPeers.some((b) => bucketUsesPostReceiptSemantics(b));
  const hasBills = transactionalPeers.some((b) => bucketUsesBillsSemantics(b));
  const unpaid = semanticOutstandingBillsMatch(thread);
  const post = semanticPostTransactionReceiptMatch(thread);

  if (bucketUsesBillsSemantics(bucket)) {
    if (hasReceipt) {
      return unpaid;
    }
    /** Bills-only: outstanding payables only — not the same bucket as Receipts (no shipped/paid proof here). */
    return unpaid;
  }

  if (bucketUsesPostReceiptSemantics(bucket)) {
    if (hasBills) {
      return post;
    }
    /** Receipts-only: still absorb unpaid mail so one bucket does not leak invoices to Can wait. */
    return unpaid || post;
  }

  return false;
}

/**
 * Vetoes for job routing — scoped to subject + sender + the *head* of the preview so
 * footer lines ("Unsubscribe", "digest", "newsletter") do not strip real job alerts.
 */
const JOBS_NEGATIVE = [
  /\bnewsletter\b/i,
  /\b%\s*off\b/i,
  /\bfree shipping\b/i,
  /\bblack friday\b/i,
  /\bweekly (roundup|update)\b/i,
  /\bmarketing\b.*\bemail\b/i,
];

const JOBS_POSITIVE = [
  /\b(new\s+)?job\s+opportunit(y|ies)\b/i,
  /\broles?\s+open\b/i,
  /\blinkedin\b.*\b(hired\s+roles|roles\s+near\s+you|job\s+alerts?|recommended\s+jobs)\b/i,
  /\bhired\s+roles\b|\broles\s+near\s+you\b|\bjob\s+alerts?\b|\brecommended\s+jobs\b|\bpeople\s+hired\b/i,
  /\binterview\b/i,
  /\brecruit(er|ing|ment)?\b/i,
  /** Domains like motionrecruitment.com (no \\b before "recruit"). */
  /recruit(ment|er|ing)\./i,
  /\bhiring\b|\bwe are hiring\b/i,
  /\bsoftware\s+engineer:.*(?:hired|role)/i,
  /\bjobs?\s+@\b/i,
  /\bcareers?\s*[<(]/i,
  /\bthank you for (your )?application\b/i,
  /\bmoving forward with (other candidates|another candidate)\b/i,
  /\bjob application\b/i,
  /\bapplication (received|submitted|update|status)\b/i,
  /\bphone screen\b/i,
  /\bon-?site\b/i,
  /\b(hm|hiring manager)\b/i,
  /\bschedule(d|)? (a |your |an )?(call|meet|zoom|conversation)\b/i,
  /\bcoding (assessment|challenge)\b/i,
  /\btake-?home\b/i,
  /\boffer(\s|$)(letter|discussion)\b|\bemployment offer\b/i,
  /\b(candidate|vacancy)\b/i,
  /\bposition (you|'ve|have) (applied|interview)/i,
  /\.(greenhouse|lever|ashbyhq|workable|smartrecruiters)\./i,
  /\b@(talent|recruit|careers)[^.\s]*\./i,
  /\blinkedin\s+.*\b(application|applied|messaged).*role\b/i,
];

/** Rules fallback only — recruiter / interviews / hiring pipeline signals. */
export function semanticJobsMatch(thread: EmailThread): boolean {
  const full = `${thread.subject}\n${thread.preview}\n${thread.sender}`;
  const previewHead = thread.preview.slice(0, 360);
  const negativeSurface = `${thread.subject}\n${thread.sender}\n${previewHead}`;
  if (JOBS_NEGATIVE.some((pattern) => pattern.test(negativeSurface))) {
    return false;
  }
  return JOBS_POSITIVE.some((pattern) => pattern.test(full));
}

/** Built-in Gmail-style buckets — keep definitions tight so \"Can wait\" does not swallow the inbox. */
const DEFAULT_BUCKET_SEMANTICS: Record<string, string> = {
  Important:
    "Needs judgment soon: security/account alerts, direct personal asks, real deadlines from people you know, substantive work blockers. " +
    "NOT retail launches, store sales, brand hype (\"PREVIEW:\", \"EMAIL ONLY SALE\"), gaming platform marketing digests, or generic promos—those belong in Newsletter.",
  "Can wait":
    "Non-urgent personal or work mail that is not bulk marketing, not recruiting, not pure automation. " +
    "Do NOT park mass retail/LinkedIn job digests or newsletters here when Newsletter or Jobs fits better—\"Can wait\" should be a modest slice of the inbox, not the default.",
  "Auto-archive":
    "Routine machine-generated mail you will not reply to: OTP/2FA codes, shipping/tracking pings, passwordless sign-in, routine account notifications without a required action. " +
    "If the user has a Receipts or Bills/Billing bucket, prefer Bills for unpaid invoices and Receipts for post-payment confirmations instead of here when appropriate.",
  Newsletter:
    "Bulk / broadcast: marketing, promos, retail sales, \"weekly\" digests, roundups, subscriber-only deals, product launch emails, most noreply brand campaigns. " +
    "When in doubt between Newsletter and Can wait, prefer Newsletter for anything with sale language, PREVIEW launches, or mass-audience tone.",
};

/** Map bucket display name → short LLM interpretation. */
export function buildBucketSemanticsForLlm(allowedBuckets: string[]): Record<string, string> {
  const semantics: Record<string, string> = {};
  const hasReceiptBucket = allowedBuckets.some((b) => bucketUsesPostReceiptSemantics(b));
  const hasBillsBucket = allowedBuckets.some((b) => bucketUsesBillsSemantics(b));
  const differentiate = hasReceiptBucket && hasBillsBucket;

  for (const raw of allowedBuckets) {
    const trimmedDefault = DEFAULT_BUCKET_SEMANTICS[raw.trim()];
    if (trimmedDefault) {
      semantics[raw] = trimmedDefault;
      continue;
    }

    const key = raw.trim().toLowerCase();
    if (/^jobs?$/.test(key) || /^job\s*hunt(ing)?$/.test(key)) {
      semantics[raw] =
        "Recruiting / careers: recruiter or HM outreach; interview scheduling; applications and status updates; ATS tools (Greenhouse, Lever, Ashby…); " +
        "LinkedIn (or similar) job alerts including lines like hired roles near you / recommended roles; offers or rejections. " +
        "NOT shopping newsletters or generic LinkedIn social digests unrelated to interviewing or applying.";
      continue;
    }

    if (bucketUsesPostReceiptSemantics(raw)) {
      semantics[raw] =
        "Post-payment and fulfillment: proofs of purchase, receipts, merchant payment confirmations (\"payment received\", \"thank you for your purchase\"), " +
        "order/shipped/delivered notices when there is no remaining balance owed. NOT emails whose main ask is paying an unpaid invoice—that belongs in Bills when that bucket exists." +
        (differentiate
          ? ` If BOTH Receipts and Bills exist, Receipts ONLY for cleared/post-settlement docs; Bills for outstanding balance.`
          : ` If only Receipts exists, also include unpaid invoices and bills awaiting payment—the user has no separate Bills bucket.`);

      continue;
    }

    if (bucketUsesBillsSemantics(raw)) {
      semantics[raw] =
        "Outstanding payables ONLY: invoices you must still pay (amount due, pay by/overdue), unpaid utility/subscription cycles, payment-required notices. " +
        "NOT order-shipped, payment-received, or thank-you-for-your-order mail—those belong in Receipts when that bucket exists, otherwise default buckets (not Bills)." +
        (differentiate
          ? ` If BOTH Bills and Receipts exist, Bills ONLY for monies still owed; completed payments and fulfillment proof go to Receipts.`
          : ` If only a Bills bucket exists (no Receipts), still restrict to unpaid/owed language only—do not use Bills for post-payment confirmations or shipping-only updates.`);
      continue;
    }

    const label = raw.trim();
    semantics[raw] =
      `User-defined bucket "${label}": use when subject, snippet, and sender clearly fit this label's everyday meaning. ` +
      `If another allowed bucket (including defaults) is a clearer fit, prefer that instead of stretching this label.`;
  }

  return semantics;
}
