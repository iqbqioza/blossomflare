import { useCallback, useEffect, useRef, useState } from "react";
import {
  addUploader,
  ApiError,
  clearSessionToken,
  createSession,
  deleteBlob,
  getStats,
  listBlobs,
  listReports,
  listUploaders,
  logout,
  removeUploader,
  restoreSession,
  updateSettings,
  uploadBlob,
  type AdminSettings,
  type BlobRecord,
  type ReportRecord,
  type Stats,
  type UploaderEntry,
  type UploadPolicy,
} from "./api";
import {
  encodeNpub,
  formatBytes,
  formatDate,
  hasNip07,
  parsePubkeyInput,
  shortHex,
} from "./nostr";

type Tab = "dashboard" | "blobs" | "uploaders" | "reports";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "blobs", label: "Blob" },
  { id: "uploaders", label: "Upload permissions" },
  { id: "reports", label: "Reports" },
];

export default function App() {
  const [session, setSession] = useState<AdminSettings | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;

    restoreSession()
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not restore session",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      clearSessionToken();
      setSession(null);
      setError("Could not authenticate as an administrator");
      return;
    }
    setError(err instanceof Error ? err.message : "An unknown error occurred");
  }, []);

  const login = async () => {
    setError(null);
    setLoggingIn(true);
    try {
      setSession(await createSession());
    } catch (err) {
      handleError(err);
    } finally {
      setLoggingIn(false);
    }
  };

  const signOut = async () => {
    setLoggingOut(true);
    try {
      await logout();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    } finally {
      setSession(null);
      setLoggingOut(false);
    }
  };

  if (restoring) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-sm text-neutral-500">
        Restoring session...
      </div>
    );
  }

  if (session === null) {
    return (
      <Login
        loggingIn={loggingIn}
        error={error}
        onLogin={login}
      />
    );
  }

  return (
    <div className="min-h-screen bg-black text-white md:flex">
      <aside className="border-b border-neutral-800 bg-neutral-950 md:fixed md:inset-y-0 md:left-0 md:z-20 md:h-screen md:w-64 md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="flex h-full flex-col">
          <div className="border-b border-neutral-800 px-5 py-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-neutral-500">
              Blossomflare
            </p>
            <h1 className="mt-2 text-lg font-semibold tracking-tight">
              Admin
            </h1>
            <p
              className="mt-3 truncate font-mono text-[11px] text-neutral-500"
              title={encodeNpub(session.adminPubkey)}
            >
              {shortHex(encodeNpub(session.adminPubkey), 12)}
            </p>
          </div>

          <nav
            aria-label="Admin sections"
            className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  tab === item.id
                    ? "bg-white font-medium text-black"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="border-t border-neutral-800 p-3 md:mt-auto">
            <button
              type="button"
              disabled={loggingOut}
              className="w-full rounded-md border border-neutral-800 px-3 py-2 text-left text-sm text-neutral-400 transition-colors hover:border-neutral-600 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
              onClick={() => void signOut()}
            >
              {loggingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 md:pl-64">
        <main className="mx-auto max-w-6xl px-5 py-8 md:px-10">
          {error !== null && (
            <div className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">
              <span>{error}</span>
              <button
                type="button"
                className="text-neutral-500 hover:text-white"
                onClick={() => setError(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {tab === "dashboard" && <Dashboard onError={handleError} />}
          {tab === "blobs" && (
            <Blobs
              maxUploadBytes={session.maxUploadBytes}
              onError={handleError}
            />
          )}
          {tab === "uploaders" && (
            <Uploaders
              session={session}
              onError={handleError}
              onPolicyChange={(uploadPolicy) =>
                setSession((current) =>
                  current === null ? current : { ...current, uploadPolicy }
                )
              }
            />
          )}
          {tab === "reports" && <Reports onError={handleError} />}
        </main>
      </div>
    </div>
  );
}

function Login(props: {
  loggingIn: boolean;
  error: string | null;
  onLogin: () => Promise<void>;
}) {
  const available = hasNip07();

  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 p-8">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-white" />
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-neutral-500">
            Blossomflare
          </p>
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          Admin sign-in
        </h1>

        {!available && (
          <div className="mt-5 border border-neutral-800 bg-black px-4 py-3 text-sm text-neutral-300">
            Install a NIP-07-compatible browser extension such as Alby.
          </div>
        )}

        {props.error !== null && (
          <div className="mt-5 border border-neutral-800 bg-black px-4 py-3 text-sm text-neutral-300">
            {props.error}
          </div>
        )}

        <button
          type="button"
          disabled={!available || props.loggingIn}
          onClick={() => void props.onLogin()}
          className="mt-6 w-full bg-white px-4 py-2.5 font-medium text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {props.loggingIn ? "Checking..." : "Sign in with NIP-07"}
        </button>
      </div>
    </div>
  );
}

function Dashboard(props: { onError: (error: unknown) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStats()
      .then((value) => {
        if (!cancelled) setStats(value);
      })
      .catch((error) => {
        if (!cancelled) props.onError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.onError]);

  if (loading) return <Loading />;
  if (stats === null) return <Empty text="Could not load statistics" />;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Blobs" value={stats.blobCount.toLocaleString("en-US")} />
      <StatCard label="Total size" value={formatBytes(stats.totalBytes)} />
      <StatCard label="Reports" value={stats.reportCount.toLocaleString("en-US")} />
      <StatCard
        label="Allowlist"
        value={stats.uploaderCount.toLocaleString("en-US")}
      />
    </div>
  );
}

function StatCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
      <p className="text-sm text-neutral-400">{props.label}</p>
      <p className="mt-2 text-2xl font-semibold">{props.value}</p>
    </div>
  );
}

const THUMBNAIL_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function BlobThumbnail(props: { blob: BlobRecord }) {
  const [failed, setFailed] = useState(false);
  const type = props.blob.type.toLowerCase().split(";")[0]?.trim() ?? "";
  const isImage = THUMBNAIL_IMAGE_TYPES.has(type);

  if (!isImage || failed) {
    return (
      <div
        className="flex h-10 w-10 items-center justify-center rounded border border-neutral-800 bg-neutral-950 text-[10px] uppercase tracking-wide text-neutral-600"
        title={props.blob.type || "Unknown type"}
        aria-hidden="true"
      >
        {isImage ? "IMG" : "FILE"}
      </div>
    );
  }

  return (
    <img
      src={props.blob.url}
      alt=""
      title={props.blob.type}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-10 w-10 rounded border border-neutral-800 bg-neutral-950 object-cover"
    />
  );
}

function Blobs(props: {
  maxUploadBytes: number;
  onError: (error: unknown) => void;
}) {
  const [blobs, setBlobs] = useState<BlobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deletingSha, setDeletingSha] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const cursor = cursors[cursorIndex] ?? null;
  const navigatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNextCursor(null);
    listBlobs({ cursor, ...(filter ? { pubkey: filter } : {}) })
      .then((result) => {
        if (cancelled) return;
        setBlobs(result.blobs);
        setNextCursor(result.nextCursor);
      })
      .catch((error) => {
        if (!cancelled) {
          setBlobs([]);
          setNextCursor(null);
          props.onError(error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          navigatingRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, filter, reloadKey, props.onError]);

  const reload = () => setReloadKey((value) => value + 1);

  const goPrevious = () => {
    if (loading || cursorIndex === 0 || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursorIndex((value) => Math.max(0, value - 1));
  };

  const goNext = () => {
    if (loading || nextCursor === null || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursors((value) => [
      ...value.slice(0, cursorIndex + 1),
      nextCursor,
    ]);
    setCursorIndex((value) => value + 1);
  };

  const applyFilter = () => {
    const value = filterInput.trim().toLowerCase();
    if (value !== "" && !/^[0-9a-f]{64}$/.test(value)) {
      setMessage("Pubkey must be a 64-character hex string");
      return;
    }
    setFilter(value);
    setCursors([null]);
    setCursorIndex(0);
  };

  const onUpload = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (file.size > props.maxUploadBytes) {
      setMessage(
        `File is too large (maximum ${formatBytes(props.maxUploadBytes)})`,
      );
      return;
    }

    setUploading(true);
    setMessage(null);
    try {
      const descriptor = await uploadBlob(file);
      setMessage(`Uploaded: ${descriptor.url}`);
      reload();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        props.onError(error);
        return;
      }
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (blob: BlobRecord) => {
    if (deletingSha !== null) return;
    if (!window.confirm(`Delete this blob?\n${blob.sha256}`)) return;

    setDeletingSha(blob.sha256);
    setMessage(null);
    try {
      await deleteBlob(blob.sha256);
      setMessage("Blob deleted");
      reload();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        props.onError(error);
        return;
      }
      setMessage(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setDeletingSha(null);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("URL copied");
    } catch {
      setMessage("Could not copy to clipboard");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-950 p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-semibold">Blob management</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Uploads and deletions are signed with NIP-07.
          </p>
        </div>
        <label className="cursor-pointer rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200">
          {uploading ? "Uploading..." : "Upload file"}
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(event) => {
              void onUpload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {message !== null && (
        <div className="rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-neutral-300">
          {message}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={filterInput}
          onChange={(event) => setFilterInput(event.target.value)}
          placeholder="Filter by pubkey (64-character hex)"
          maxLength={64}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm outline-none focus:border-white"
        />
        <button
          type="button"
          onClick={applyFilter}
          className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900"
        >
          Filter
        </button>
        {filter !== "" && (
          <button
            type="button"
            onClick={() => {
              setFilterInput("");
              setFilter("");
              setCursors([null]);
              setCursorIndex(0);
            }}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-900"
          >
            Clear
          </button>
        )}
      </div>

      {loading ? (
        <Loading />
      ) : blobs.length === 0 ? (
        <Empty text="No blobs found" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800">
          <table className="min-w-full divide-y divide-neutral-800 text-sm">
            <thead className="bg-neutral-950 text-left text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-4 py-3">Preview</th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800 bg-black">
              {blobs.map((blob) => (
                <tr key={blob.sha256}>
                  <td className="px-4 py-3">
                    <BlobThumbnail blob={blob} />
                  </td>
                  <td className="max-w-xs px-4 py-3">
                    <a
                      href={blob.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-mono text-white hover:text-neutral-300"
                      title={blob.url}
                    >
                      {blob.url}
                    </a>
                    <button
                      type="button"
                      onClick={() => void copy(blob.url)}
                      className="mt-1 text-xs text-neutral-500 hover:text-neutral-300"
                    >
                      Copy
                    </button>
                  </td>
                  <td className="px-4 py-3 text-neutral-300">{blob.type}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-300">
                    {formatBytes(blob.size)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                    {formatDate(blob.uploaded)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                    {shortHex(encodeNpub(blob.pubkey), 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={deletingSha !== null}
                      onClick={() => void onDelete(blob)}
                      className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {deletingSha === blob.sha256 ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-neutral-400">
        <span>Page {cursorIndex + 1}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={loading || cursorIndex === 0}
            onClick={goPrevious}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={loading || nextCursor === null}
            onClick={goNext}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function Uploaders(props: {
  session: AdminSettings;
  onError: (error: unknown) => void;
  onPolicyChange: (policy: UploadPolicy) => void;
}) {
  const [policy, setPolicy] = useState<UploadPolicy>(props.session.uploadPolicy);
  const [uploaders, setUploaders] = useState<UploaderEntry[]>([]);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const cursor = cursors[cursorIndex] ?? null;
  const navigatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNextCursor(null);
    listUploaders(cursor)
      .then((result) => {
        if (cancelled) return;
        setUploaders(result.uploaders);
        setNextCursor(result.nextCursor);
      })
      .catch((error) => {
        if (!cancelled) {
          setUploaders([]);
          setNextCursor(null);
          props.onError(error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          navigatingRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, reloadKey, props.onError]);

  const reload = () => setReloadKey((value) => value + 1);

  const goPrevious = () => {
    if (loading || cursorIndex === 0 || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursorIndex((value) => Math.max(0, value - 1));
  };

  const goNext = () => {
    if (loading || nextCursor === null || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursors((value) => [
      ...value.slice(0, cursorIndex + 1),
      nextCursor,
    ]);
    setCursorIndex((value) => value + 1);
  };

  const changePolicy = async (next: UploadPolicy) => {
    if (next === policy) return;
    setSavingPolicy(true);
    setMessage(null);
    try {
      await updateSettings(next);
      setPolicy(next);
      props.onPolicyChange(next);
      setMessage("Upload policy updated");
    } catch (error) {
      props.onError(error);
    } finally {
      setSavingPolicy(false);
    }
  };

  const add = async () => {
    if (saving) return;
    const parsed = parsePubkeyInput(input);
    if ("error" in parsed) {
      setMessage(parsed.error);
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const result = await addUploader(parsed.hex);
      setInput("");
      setMessage(
        result.created
          ? `Added npub: ${encodeNpub(result.pubkey)}`
          : "This npub is already on the allowlist",
      );
      reload();
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (pubkey: string) => {
    if (saving) return;
    if (!window.confirm(`Remove from the allowlist?\n${encodeNpub(pubkey)}`)) {
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      await removeUploader(pubkey);
      setMessage("Removed from the allowlist. Existing blobs remain.");
      reload();
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("npub copied");
    } catch {
      setMessage("Could not copy to clipboard");
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="font-semibold">Upload policy</h2>
        <p className="mt-1 text-sm text-neutral-400">
          The administrator can always upload, regardless of policy.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <PolicyOption
            checked={policy === "allowlist"}
            title="Allowlisted npubs only"
            description="Only registered Nostr pubkeys and the administrator can upload."
            disabled={savingPolicy}
            onChange={() => void changePolicy("allowlist")}
          />
          <PolicyOption
            checked={policy === "open"}
            title="All Nostr users"
            description="Any user with a valid Blossom authorization token can upload."
            disabled={savingPolicy}
            onChange={() => void changePolicy("open")}
          />
        </div>
        {policy === "allowlist" && cursorIndex === 0 && uploaders.length === 0 && (
          <p className="mt-4 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-300">
            The allowlist is empty. Only the administrator can upload right now.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="font-semibold">Allowed npubs</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="npub1... or 64-character hex"
            maxLength={100}
            className="w-full rounded-lg border border-neutral-700 bg-black px-3 py-2 font-mono text-sm outline-none focus:border-white"
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void add()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Never enter a private key (nsec).
        </p>

        {message !== null && (
          <div className="mt-4 rounded-lg border border-neutral-700 bg-black px-4 py-3 text-sm text-neutral-300">
            {message}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm">
          <span className="text-white">Administrator</span>
          <span className="ml-2 font-mono text-xs text-neutral-400">
            {shortHex(encodeNpub(props.session.adminPubkey), 14)}
          </span>
          <span className="ml-2 text-xs text-neutral-500">Always allowed</span>
        </div>

        {loading ? (
          <Loading />
        ) : uploaders.length === 0 ? (
          <Empty text="No npubs are on the allowlist" />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="min-w-full divide-y divide-neutral-800 text-sm">
              <thead className="bg-black text-left text-xs uppercase tracking-wide text-neutral-400">
                <tr>
                  <th className="px-4 py-3">npub</th>
                  <th className="px-4 py-3">Added</th>
                  <th className="px-4 py-3">Added by</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {uploaders.map((entry) => {
                  const npub = encodeNpub(entry.pubkey);
                  return (
                    <tr key={entry.pubkey}>
                      <td className="max-w-xs px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void copy(npub)}
                          className="block truncate font-mono text-xs text-white hover:text-neutral-300"
                          title={npub}
                        >
                          {npub}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                        {formatDate(entry.addedAt)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                        {shortHex(encodeNpub(entry.addedBy), 8)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void remove(entry.pubkey)}
                          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-sm text-neutral-400">
          <span>Page {cursorIndex + 1}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading || cursorIndex === 0}
              onClick={goPrevious}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={loading || nextCursor === null}
              onClick={goNext}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PolicyOption(props: {
  checked: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`cursor-pointer rounded-lg border p-4 ${
        props.checked
          ? "border-white bg-neutral-900"
          : "border-neutral-700 bg-black"
      } ${props.disabled ? "opacity-60" : ""}`}
    >
      <input
        type="radio"
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        className="mr-2 accent-white"
      />
      <span className="font-medium">{props.title}</span>
      <p className="mt-2 pl-6 text-sm text-neutral-400">{props.description}</p>
    </label>
  );
}

function Reports(props: { onError: (error: unknown) => void }) {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const cursor = cursors[cursorIndex] ?? null;
  const navigatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNextCursor(null);
    listReports(cursor)
      .then((result) => {
        if (cancelled) return;
        setReports(result.reports);
        setNextCursor(result.nextCursor);
      })
      .catch((error) => {
        if (!cancelled) {
          setReports([]);
          setNextCursor(null);
          props.onError(error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          navigatingRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, props.onError]);

  const goPrevious = () => {
    if (loading || cursorIndex === 0 || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursorIndex((value) => Math.max(0, value - 1));
  };

  const goNext = () => {
    if (loading || nextCursor === null || navigatingRef.current) return;
    navigatingRef.current = true;
    setCursors((value) => [
      ...value.slice(0, cursorIndex + 1),
      nextCursor,
    ]);
    setCursorIndex((value) => value + 1);
  };

  if (loading) return <Loading />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold">Blob reports</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Reports submitted as NIP-56 (kind 1984).
        </p>
      </div>

      {reports.length === 0 ? (
        <Empty text="No reports" />
      ) : (
        reports.map((report) => {
          const xTags = report.event?.tags.filter((tag) => tag[0] === "x") ?? [];
          return (
            <article
              key={report.id}
              className="rounded-xl border border-neutral-800 bg-neutral-950 p-5"
            >
              <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono text-xs text-neutral-500">
                  {report.id}
                </span>
                <span className="text-neutral-400">
                  {formatDate(report.receivedAt)}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-200">
                {report.event?.content || "(No content)"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {xTags.map((tag, index) => (
                  <code
                    key={`${tag[1] ?? "x"}-${index}`}
                    className="rounded bg-black px-2 py-1 text-xs text-neutral-400"
                  >
                    {tag[1]} {tag[2] ? `(${tag[2]})` : ""}
                  </code>
                ))}
              </div>
              <p className="mt-3 font-mono text-xs text-neutral-500">
                Reporter: {shortHex(encodeNpub(report.pubkey), 10)}
              </p>
              <details className="mt-3 text-xs text-neutral-500">
                <summary className="cursor-pointer hover:text-neutral-300">
                  Raw event JSON
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-black p-3">
                  {JSON.stringify(report.event, null, 2)}
                </pre>
              </details>
            </article>
          );
        })
      )}

      <div className="flex items-center justify-between text-sm text-neutral-400">
        <span>Page {cursorIndex + 1}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={loading || cursorIndex === 0}
            onClick={goPrevious}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={loading || nextCursor === null}
            onClick={goNext}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="py-12 text-center text-sm text-neutral-500">Loading...</div>
  );
}

function Empty(props: { text: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-12 text-center text-sm text-neutral-500">
      {props.text}
    </div>
  );
}
