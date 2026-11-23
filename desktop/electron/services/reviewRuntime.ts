import type { DB } from "../db";
import type { ReviewPatch, RvResult } from "../../shared/types";
import { updateFileReview } from "./reviewFileEdits";

const KINDS = new Set(["book", "series", "draft", "orphan"]);
const DEBOUNCE_MS = 2000;

type Kind = "book" | "series" | "draft" | "orphan";

interface Pending {
  kind: Kind;
  id: number;
  dir: string;
  patch: ReviewPatch & {
    md: string;
    expectedVersion: string;
    expectedFileName: string;
    editRevision: number;
  };
}

interface Base {
  dir: string;
  editRevision: number;
  preVersion: string;
  postVersion: string;
}

const fail = (msg: string): RvResult => ({ ok: false, msg } as RvResult);

export class ReviewRuntime {
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly bases = new Map<string, Base>();

  constructor(
    private readonly getCtx: () => { db: DB; dir: string; recoveryDir: string } | null,
    private readonly notify: (kind: string, id: number, result: RvResult) => void,
  ) {}

  private key(kind: string, id: number): string {
    return `${kind}:${id}`;
  }

  stage(kind: string, id: number, p: ReviewPatch): RvResult {
    if (!KINDS.has(kind)) return fail("invalid review kind");
    if (!Number.isInteger(id) || id <= 0) return fail("invalid review id");
    if (!p || typeof p.md !== "string") return fail("invalid review body");

    const md = p.md;
    const expectedVersion = p.expectedVersion;
    const expectedFileName = p.expectedFileName;
    const editRevision = p.editRevision;

    if (typeof expectedVersion !== "string") return fail("invalid expectedVersion");
    if (typeof expectedFileName !== "string") return fail("invalid expectedFileName");
    if (
      typeof editRevision !== "number" ||
      !Number.isFinite(editRevision) ||
      editRevision <= 0
    ) {
      return fail("invalid editRevision");
    }

    const ctx = this.getCtx();
    if (!ctx) return fail("review store unavailable");

    const k = this.key(kind, id);
    const pending = this.pending.get(k);
    if (pending && pending.dir !== ctx.dir) return fail("review store changed");
    const base = this.bases.get(k);
    if (base && base.dir !== ctx.dir) return fail("review store changed");

    let patch: Pending["patch"] = {
      ...p,
      md,
      expectedVersion,
      expectedFileName,
      editRevision,
    };

    if (
      base &&
      patch.expectedVersion === base.preVersion &&
      patch.editRevision > base.editRevision
    ) {
      patch = { ...patch, expectedVersion: base.postVersion };
      this.bases.set(k, { ...base, preVersion: base.postVersion });
    }

    this.pending.set(k, { kind: kind as Kind, id, dir: ctx.dir, patch });
    const old = this.timers.get(k);
    if (old) clearTimeout(old);
    this.timers.set(k, setTimeout(() => {
      this.timers.delete(k);
      this.flushKey(k);
    }, DEBOUNCE_MS));

    return { ok: true, editRevision: patch.editRevision } as RvResult;
  }

  private save(item: Pending): RvResult {
    const ctx = this.getCtx();
    if (!ctx || ctx.dir !== item.dir) return fail("review store changed");
    try {
      const result = updateFileReview(
        ctx.db,
        ctx.dir,
        ctx.recoveryDir,
        item.kind,
        item.id,
        item.patch,
      );
      if (result && result.ok) {
        const version = (result as { version?: unknown }).version;
        if (typeof version === "string") {
          this.bases.set(this.key(item.kind, item.id), {
            dir: ctx.dir,
            editRevision: item.patch.editRevision,
            preVersion: item.patch.expectedVersion,
            postVersion: version,
          });
        }
      }
      return result;
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  private recoveryPathOf(result: RvResult): string | undefined {
    const recoveryPath = (result as { recoveryPath?: unknown }).recoveryPath;
    return typeof recoveryPath === "string" ? recoveryPath : undefined;
  }

  private settled(result: RvResult): boolean {
    if (!result) return false;
    if (result.ok) return true;
    return this.recoveryPathOf(result) !== undefined;
  }

  private messageOf(result: RvResult, fallback: string): string {
    return typeof result.msg === "string" && result.msg ? result.msg : fallback;
  }

  private flushKey(k: string): void {
    const item = this.pending.get(k);
    if (!item) return;
    const result = this.save(item);
    if (this.settled(result)) this.pending.delete(k);
    this.notify(item.kind, item.id, {
      ...result,
      editRevision: item.patch.editRevision,
    } as RvResult);
  }

  flushAll(): RvResult {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    const items = [...this.pending.entries()];
    if (items.length === 0) return { ok: true } as RvResult;

    let ok = true;
    let firstBlockingMsg: string | undefined;
    let recoveryPath: string | undefined;
    let recoveryMsg: string | undefined;

    for (const [k, item] of items) {
      const result = this.save(item);
      const path = this.recoveryPathOf(result);
      if (path && !recoveryPath) {
        recoveryPath = path;
        recoveryMsg = this.messageOf(result, "review recovery saved");
      }

      if (this.settled(result)) {
        this.pending.delete(k);
      } else {
        ok = false;
        if (!firstBlockingMsg) {
          firstBlockingMsg = this.messageOf(result, "review save failed");
        }
      }

      this.notify(item.kind, item.id, {
        ...result,
        editRevision: item.patch.editRevision,
      } as RvResult);
    }

    const out: RvResult & { recoveryPath?: string } = { ok };
    if (!ok && firstBlockingMsg) out.msg = firstBlockingMsg;
    if (recoveryPath) out.recoveryPath = recoveryPath;
    if (!out.msg && recoveryMsg) out.msg = recoveryMsg;
    return out;
  }
}

export default ReviewRuntime;
