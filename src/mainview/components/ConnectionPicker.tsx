// Which machine you are typing into, and how to change it (remote.md §8).
//
// A dialog rather than an anchored menu, because most of what it does is
// deliberate rather than quick: switching tears the session down and rebuilds
// it, and adding or re-addressing a server means reading a host-key fingerprint
// and deciding whether it is the right one. The list itself stays keyboard-first
// like every other list in the app — arrows move, Enter switches, ⌫ removes.
//
// Pinning is two steps on purpose. Ledge asks the host for its key, shows the
// fingerprint, and pins only after someone says that is the key they expected;
// there is no "connect anyway" that remembers, because that is the thing
// host-key pinning exists to prevent (§4). Editing an address onto a different
// host asks the same question again, for the same reason: a pin is a claim
// about one machine and does not follow a connection to another.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, Laptop, Loader2, Pencil, Server, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import {
  addConnection,
  connectionStatus,
  probeConnection,
  removeConnection,
  selectConnection,
  updateConnection,
  type ConnectionStatus,
} from "@/lib/connections";
import { flushAllNow } from "@/notes/store";
import { copyText } from "@/lib/clipboard";
import { deviceKeyLine } from "@/lib/shell";
import { hostPart, parsePort } from "../../shared/connections";
import type { ConnectionInfo } from "../../shared/rpc-schema";

// What a host answered, waiting to be confirmed. Held rather than pinned: the
// whole point of the step is that a person looks at `fingerprint` first.
interface Probed {
  hostKey: string;
  fingerprint: string;
  keyType: string;
}

export function ConnectionPicker({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ConnectionStatus>(connectionStatus());
  // Null for the list, "new" for the add form, a connection for the edit form.
  const [form, setForm] = useState<ConnectionInfo | "new" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => pushLayer("dialog", onClose), [onClose]);

  const switchTo = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    // On success this never returns: selectConnection reloads the page, which
    // is how everything server-scoped gets rebuilt.
    const refusal = await selectConnection(id, flushAllNow);
    if (refusal) {
      setError(refusal);
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const refusal = await removeConnection(id);
    if (refusal) setError(refusal);
    else setStatus(connectionStatus());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connections"
        className="flex w-full max-w-lg flex-col rounded-lg border bg-background p-4 shadow-xl"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Notes on</h2>
          <span className="text-[11px] text-muted-foreground">One machine at a time</span>
        </div>

        {form ? (
          <ConnectionForm
            existing={form === "new" ? null : form}
            // Editing the machine being served re-opens it, so the page has to
            // start over on the other side of it — the same rebuild a switch
            // gets, and for the same reason (lib/connections.ts).
            serving={form !== "new" && form.id === status.active}
            onCancel={() => setForm(null)}
            onDone={() => {
              setForm(null);
              setStatus(connectionStatus());
            }}
          />
        ) : (
          <>
            <ConnectionList
              status={status}
              busy={busy}
              onPick={switchTo}
              onEdit={(conn) => {
                setError("");
                setForm(conn);
              }}
              onRemove={remove}
            />
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                Switching closes every tab and reopens this machine&apos;s.
              </p>
              <Button size="sm" variant="ghost" onClick={() => setForm("new")}>
                <Plus className="mr-1 size-3.5" />
                Add Server…
              </Button>
            </div>
          </>
        )}

        {error && <p className="mt-2 text-[12px] leading-snug text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function ConnectionList({
  status,
  busy,
  onPick,
  onEdit,
  onRemove,
}: {
  status: ConnectionStatus;
  busy: boolean;
  onPick: (id: string) => void;
  onEdit: (conn: ConnectionInfo) => void;
  onRemove: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Opens on the connection in use, so Enter is "stay here" and moving costs a
  // deliberate arrow — the same stance the host picker takes about running a
  // block on the wrong machine.
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>("[data-active=true]")?.focus();
  }, []);

  // Roving focus by hand rather than through useListNav: that hook marks rows
  // `data-list-row`, which puts the command dispatcher into its list domain
  // and would arm every bare row verb in the app (⌫ closes a workspace) inside
  // a modal about something else entirely.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
    // By the row a focused control BELONGS to, not by the focused element: the
    // edit and remove buttons are in the tab order beside their row, and an
    // arrow pressed from one of them means the row it is part of.
    const at = rows.findIndex((row) => row.parentElement?.contains(document.activeElement));
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Connections"
      onKeyDown={onKeyDown}
      className="mt-3 flex flex-col gap-0.5"
    >
      {status.connections.map((conn) => (
        <ConnectionRow
          key={conn.id}
          conn={conn}
          active={conn.id === status.active}
          // The one the user chose, when that is not the one they got: a boot
          // that fell back has to say so on the row it fell back FROM, or the
          // indicator is the only place the failure exists.
          failed={conn.id === status.wanted && status.wanted !== status.active ? status.error : ""}
          busy={busy}
          onPick={() => onPick(conn.id)}
          onEdit={() => onEdit(conn)}
          onRemove={() => onRemove(conn.id)}
        />
      ))}
    </div>
  );
}

function ConnectionRow({
  conn,
  active,
  failed,
  busy,
  onPick,
  onEdit,
  onRemove,
}: {
  conn: ConnectionInfo;
  active: boolean;
  failed: string;
  busy: boolean;
  onPick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const local = conn.destination === "";
  const Icon = local ? Laptop : Server;
  return (
    // Presentational, so the listbox's children are still options: the two
    // controls are siblings of the row rather than inside it, because a button
    // in a button is not markup a browser agrees to render.
    <div role="presentation" className="flex items-center gap-0.5">
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-active={active}
        disabled={busy}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60 touch:min-h-[44px]"
        onClick={onPick}
        onKeyDown={(e) => {
          // ⌫ on a focused row, the same remove verb the workspace strip uses.
          if (e.key !== "Backspace" || local) return;
          e.preventDefault();
          onRemove();
        }}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{conn.name}</span>
          {conn.destination && (
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {conn.destination}
              {conn.pinned ? " · pinned" : ""}
            </span>
          )}
          {failed && <span className="block truncate text-[11px] text-destructive">{failed}</span>}
        </span>
        {active && <Check className="size-3.5 shrink-0" />}
      </button>
      {/* Always there, never revealed by a hover: a control a pointer has to
          summon is a control a phone cannot reach at all, and the row verb it
          mirrors (⌫) has no touch form either (interactions.md §1a). The local
          server has neither, because it is not a record — it is the server in
          this process, and there is nothing about it to change. */}
      {!local && (
        <>
          <RowButton label={`Edit ${conn.name}`} disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </RowButton>
          <RowButton label={`Remove ${conn.name}`} disabled={busy} destructive onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </RowButton>
        </>
      )}
    </div>
  );
}

function RowButton({
  label,
  disabled,
  destructive,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      // 44 on touch, and Remove is why: this row is three adjacent
      // alternatives half a point apart — switch machine, edit it, delete it —
      // and the third is destructive (§1a orders a group by what a miss
      // costs; here Edit is what sits between the other two).
      className={`flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60 touch:size-[44px] ${
        destructive ? "hover:text-destructive focus:text-destructive" : "hover:text-foreground focus:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One server's fields, for adding a new one or changing an existing one.
 *
 * The same form both ways because the second step is the same question: what
 * gets pinned is decided by whether the ADDRESS names a host this connection
 * has no pin for, which is true of every new connection and of an edit that
 * moved one. A rename or a re-account (`dev@box` to `ledge@box`) touches no
 * host and saves in one step.
 */
function ConnectionForm({
  existing,
  serving,
  onCancel,
  onDone,
}: {
  existing: ConnectionInfo | null;
  serving: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [destination, setDestination] = useState(existing?.destination ?? "");
  // Text, not a number: an empty field is "let ssh decide" and has to stay
  // distinguishable from a half-typed one (shared/connections.ts parsePort).
  const [portText, setPortText] = useState(existing?.port ? String(existing.port) : "");
  const [keyPath, setKeyPath] = useState(existing?.keyPath ?? "");
  const [probed, setProbed] = useState<Probed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  // This client's own key, where it has one. A phone's is in the Secure Enclave
  // and has no path, so its form shows the line to install instead of asking
  // for a file (lib/shell.ts).
  const ownKey = deviceKeyLine();

  useEffect(() => firstRef.current?.focus(), []);

  // Null while the field holds something that is not a port. Every action below
  // refuses on it rather than falling back to 22, because a typo that silently
  // becomes the default connects to the wrong sshd and says nothing.
  const port = parsePort(portText);
  const BAD_PORT = "A port is a whole number from 1 to 65535.";

  // A pin belongs to one machine, and known_hosts counts a non-default port as
  // part of which machine (shared/connections.ts). Moving an address or a port
  // leaves nothing to keep, so the fingerprint step comes back; staying put
  // keeps whatever was pinned, which is what `hostKey: null` says below.
  const moved =
    existing !== null &&
    (hostPart(destination.trim()) !== hostPart(existing.destination) || (port !== null && port !== existing.port));
  const mustPin = existing === null || moved;

  const probe = async () => {
    if (port === null) return setError(BAD_PORT);
    setBusy(true);
    setError("");
    const res = await probeConnection(destination, port);
    setBusy(false);
    if (res.error) return setError(res.error);
    setProbed({ hostKey: res.hostKey, fingerprint: res.fingerprint, keyType: res.keyType });
  };

  const save = async (hostKey: string | null) => {
    if (port === null) return setError(BAD_PORT);
    setBusy(true);
    setError("");
    const refusal = existing
      ? await updateConnection(
          { id: existing.id, name, destination, port, keyPath, hostKey },
          // A changed address means the shell re-opened the wire, so this page
          // is now looking at the previous machine's session. A changed port is
          // the same re-open for the same reason.
          {
            reconnected: serving && (destination.trim() !== existing.destination || port !== existing.port),
            flush: flushAllNow,
          },
        )
      : (await addConnection({ name, destination, port, keyPath, hostKey: hostKey ?? "" })).error || null;
    setBusy(false);
    if (refusal) return setError(refusal);
    onDone();
  };

  if (probed) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-[12px] leading-snug">
          {destination} answered with this {probed.keyType || "host"} key. {existing ? "Keep" : "Add"} it only if it
          matches what that machine reports for itself.
        </p>
        <code className="select-text break-all rounded-md border border-input bg-muted/40 p-2 font-mono text-[12px]">
          {probed.fingerprint}
        </code>
        <p className="text-[11px] text-muted-foreground">
          Run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> there to compare.
        </p>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setProbed(null)}>
            Back
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save(probed.hostKey)}>
            {existing ? "It Matches, Save" : "It Matches, Add"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {ownKey && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Add this line to <code className="font-mono">~/.ssh/authorized_keys</code> on the server. It is the only
            thing that key can do.
          </span>
          <code className="select-text break-all rounded-md border border-input bg-muted/40 p-2 font-mono text-[11px]">
            {ownKey}
          </code>
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                copyText(ownKey);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy Line"}
            </Button>
          </div>
        </div>
      )}
      <Field label="Name" value={name} onChange={setName} placeholder="Laptop" inputRef={firstRef} />
      <Field label="SSH destination" value={destination} onChange={setDestination} placeholder="dev@laptop" mono />
      {/* Its own field rather than a `host:port` destination, because that is
          what ssh takes and what every other client's form asks for. Empty is
          the ordinary answer and means ssh decides. */}
      <Field label="Port (optional)" value={portText} onChange={setPortText} placeholder="22" mono />
      {/* Absent where there is no path to give: a Secure Enclave key cannot be
          read out of the enclave, let alone named by a file (ios.md §4). */}
      {!ownKey && <Field label="Key (optional)" value={keyPath} onChange={setKeyPath} placeholder="~/.ssh/ledge" mono />}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Any address ssh understands
        {ownKey ? "" : ", including a name from your ~/.ssh/config"}. Leave the port blank unless sshd listens somewhere
        other than 22. That machine needs Ledge&apos;s server on its PATH as{" "}
        <code className="font-mono">ledge-server</code>.
      </p>
      {error && <p className="text-[12px] leading-snug text-destructive">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {/* A host that rotated its key legitimately would otherwise cost a
            delete and a re-add: the connection is right, the pin is stale, and
            this is the step that reads the new one. */}
        {existing && !mustPin && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void probe()}>
            Check Key Again
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || !name.trim() || !destination.trim()}
          onClick={() => void (mustPin ? probe() : save(null))}
        >
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          {mustPin ? "Continue" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  mono?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-md border border-input bg-transparent px-2 py-1 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring touch:min-h-[44px] ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}
