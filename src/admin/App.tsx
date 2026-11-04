import { useCallback, useEffect, useRef, useState } from "react";
import {
  addUploader,
  ApiError,
  deleteBlob,
  getSettings,
  getStats,
  listBlobs,
  listReports,
  listUploaders,
  removeUploader,
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

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
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
      setSession(await getSettings());
    } catch (err) {
      handleError(err);
    } finally {
      setLoggingIn(false);
    }
  };

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
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Blossomflare Admin
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              {shortHex(encodeNpub(session.adminPubkey), 16)}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            onClick={() => {
              setSession(null);
              setError(null);
            }}
          >
            Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                tab === item.id
                  ? "border-sky-400 text-sky-300"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {error !== null && (
          <div className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-rose-900 bg-rose-950/50 px-4 py-3 text-sm text-rose-200">
            <span>{error}</span>
            <button
              type="button"
              className="text-rose-300 hover:text-rose-100"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {tab === "dashboard" && <Dashboard onError={handleError} />}
        {tab === "blobs" && <Blobs onError={handleError} />}
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
  );
}

function Login(props: {
  loggingIn: boolean;
  error: string | null;
  onLogin: () => Promise<void>;
}) {
  const available = hasNip07();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-400">
          Blossomflare
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Admin sign-in</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Sign in with your admin npub. Your private key never leaves your browser extension.
        </p>

        {!available && (
          <div className="mt-5 rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            Install a NIP-07-compatible browser extension such as Alby.
          </div>
        )}

        {props.error !== null && (
          <div className="mt-5 rounded-lg border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {props.error}
          </div>
        )}

        <button
          type="button"
          disabled={!available || props.loggingIn}
          onClick={() => void props.onLogin()}
          className="mt-6 w-full rounded-lg bg-sky-500 px-4 py-2.5 font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {props.loggingIn ? "Checking..." : "Sign in with NIP-07"}
        </button>

        <p className="mt-4 text-xs leading-5 text-slate-500">
          Sign-in requires the pubkey configured in the Cloudflare secret `ADMIN_NPUB`.
        </p>
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
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <p className="text-sm text-slate-400">{props.label}</p>
      <p className="mt-2 text-2xl font-semibold">{props.value}</p>
    </div>
  );
}

function Blobs(props: { onError: (error: unknown) => void }) {
  const [blobs, setBlobs] = useState<BlobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
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
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const descriptor = await uploadBlob(file);
      setMessage(`Uploaded: ${descriptor.url}`);
      reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (blob: BlobRecord) => {
    if (!window.confirm(`Delete this blob?\n${blob.sha256}`)) return;
    setMessage(null);
    try {
      await deleteBlob(blob.sha256);
      setMessage("Blob deleted");
      reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Delete failed");
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
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-semibold">Blob management</h2>
          <p className="mt-1 text-sm text-slate-400">
            Uploads and deletions are signed with NIP-07.
          </p>
        </div>
        <label className="cursor-pointer rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400">
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
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-300">
          {message}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={filterInput}
          onChange={(event) => setFilterInput(event.target.value)}
          placeholder="Filter by pubkey (64-character hex)"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
        />
        <button
          type="button"
          onClick={applyFilter}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
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
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
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
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950/40">
              {blobs.map((blob) => (
                <tr key={blob.sha256}>
                  <td className="max-w-xs px-4 py-3">
                    <a
                      href={blob.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-mono text-sky-400 hover:text-sky-300"
                      title={blob.url}
                    >
                      {blob.url}
                    </a>
                    <button
                      type="button"
                      onClick={() => void copy(blob.url)}
                      className="mt-1 text-xs text-slate-500 hover:text-slate-300"
                    >
                      Copy
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{blob.type}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                    {formatBytes(blob.size)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                    {formatDate(blob.uploaded)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {shortHex(encodeNpub(blob.pubkey), 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void onDelete(blob)}
                      className="rounded-md border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950/50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-slate-400">
        <span>Page {cursorIndex + 1}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={loading || cursorIndex === 0}
            onClick={goPrevious}
            className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={loading || nextCursor === null}
            onClick={goNext}
            className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
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
    const parsed = parsePubkeyInput(input);
    if ("error" in parsed) {
      setMessage(parsed.error);
      return;
    }
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
    }
  };

  const remove = async (pubkey: string) => {
    if (!window.confirm(`Remove from the allowlist?\n${encodeNpub(pubkey)}`)) {
      return;
    }
    setMessage(null);
    try {
      await removeUploader(pubkey);
      setMessage("Removed from the allowlist. Existing blobs remain.");
      reload();
    } catch (error) {
      props.onError(error);
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
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold">Upload policy</h2>
        <p className="mt-1 text-sm text-slate-400">
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
          <p className="mt-4 rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            The allowlist is empty. Only the administrator can upload right now.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold">Allowed npubs</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="npub1... or 64-character hex"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
          />
          <button
            type="button"
            onClick={() => void add()}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400"
          >
            Add
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Never enter a private key (nsec).
        </p>

        {message !== null && (
          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-300">
            {message}
          </div>
        )}

        <div className="mt-4 rounded-lg border border-sky-900 bg-sky-950/20 px-4 py-3 text-sm">
          <span className="text-sky-300">Administrator</span>
          <span className="ml-2 font-mono text-xs text-slate-400">
            {shortHex(encodeNpub(props.session.adminPubkey), 14)}
          </span>
          <span className="ml-2 text-xs text-slate-500">Always allowed</span>
        </div>

        {loading ? (
          <Loading />
        ) : uploaders.length === 0 ? (
          <Empty text="No npubs are on the allowlist" />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-950 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">npub</th>
                  <th className="px-4 py-3">Added</th>
                  <th className="px-4 py-3">Added by</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {uploaders.map((entry) => {
                  const npub = encodeNpub(entry.pubkey);
                  return (
                    <tr key={entry.pubkey}>
                      <td className="max-w-xs px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void copy(npub)}
                          className="block truncate font-mono text-xs text-sky-400 hover:text-sky-300"
                          title={npub}
                        >
                          {npub}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                        {formatDate(entry.addedAt)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {shortHex(encodeNpub(entry.addedBy), 8)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => void remove(entry.pubkey)}
                          className="rounded-md border border-rose-900 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950/50"
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

        <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
          <span>Page {cursorIndex + 1}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading || cursorIndex === 0}
              onClick={goPrevious}
              className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={loading || nextCursor === null}
              onClick={goNext}
              className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
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
          ? "border-sky-500 bg-sky-950/30"
          : "border-slate-700 bg-slate-950"
      } ${props.disabled ? "opacity-60" : ""}`}
    >
      <input
        type="radio"
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        className="mr-2 accent-sky-500"
      />
      <span className="font-medium">{props.title}</span>
      <p className="mt-2 pl-6 text-sm text-slate-400">{props.description}</p>
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
        <p className="mt-1 text-sm text-slate-400">
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
              className="rounded-xl border border-slate-800 bg-slate-900 p-5"
            >
              <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono text-xs text-slate-500">
                  {report.id}
                </span>
                <span className="text-slate-400">
                  {formatDate(report.receivedAt)}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-200">
                {report.event?.content || "(No content)"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {xTags.map((tag, index) => (
                  <code
                    key={`${tag[1] ?? "x"}-${index}`}
                    className="rounded bg-slate-950 px-2 py-1 text-xs text-slate-400"
                  >
                    {tag[1]} {tag[2] ? `(${tag[2]})` : ""}
                  </code>
                ))}
              </div>
              <p className="mt-3 font-mono text-xs text-slate-500">
                Reporter: {shortHex(encodeNpub(report.pubkey), 10)}
              </p>
              <details className="mt-3 text-xs text-slate-500">
                <summary className="cursor-pointer hover:text-slate-300">
                  Raw event JSON
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3">
                  {JSON.stringify(report.event, null, 2)}
                </pre>
              </details>
            </article>
          );
        })
      )}

      <div className="flex items-center justify-between text-sm text-slate-400">
        <span>Page {cursorIndex + 1}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={loading || cursorIndex === 0}
            onClick={goPrevious}
            className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={loading || nextCursor === null}
            onClick={goNext}
            className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
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
    <div className="py-12 text-center text-sm text-slate-500">Loading...</div>
  );
}

function Empty(props: { text: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-12 text-center text-sm text-slate-500">
      {props.text}
    </div>
  );
}
