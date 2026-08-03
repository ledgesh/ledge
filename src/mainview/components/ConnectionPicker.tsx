// Which machine you are typing into, and how to change it (remote.md §8).
//
// A dialog rather than an anchored menu, because two of the three things it
// does are deliberate rather than quick: switching tears the session down and
// rebuilds it, and adding a server means reading a host-key fingerprint and
// deciding whether it is the right one. The list itself stays keyboard-first
// like every other list in the app — arrows move, Enter switches, ⌫ removes.
//
// Adding is two steps on purpose. Ledge asks the host for its key, shows the
// fingerprint, and pins only after someone says that is the key they expected;
// there is no "connect anyway" that remembers, because that is the thing
// host-key pinning exists to prevent (§4).
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, Laptop, Loader2, Server, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import {
  addConnection,
  connectionStatus,
  probeConnection,
  removeConnection,
  selectConnection,
  type ConnectionStatus,
} from "@/lib/connections";
import { flushAllNow } from "@/notes/store";
import { managesServers } from "@/lib/shell";
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
  const [adding, setAdding] = useState(false);
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

        {adding ? (
          <AddConnection
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              setStatus(connectionStatus());
            }}
          />
        ) : (
          <>
            <ConnectionList status={status} busy={busy} onPick={switchTo} onRemove={remove} />
            {/* The add half is a whole client's worth of assumption: that this
                process can reach an ssh binary, hold a key file, and keep a
                list. A phone can do none of the three — its one server was
                chosen on a native screen before this page existed, and its key
                is in the Secure Enclave and has no path (ios.md §4) — so
                connectionAdd, connectionRemove and connectionProbe all answer
                with a refusal there. Absent rather than present and failing
                (lib/shell.ts). The list stays, and so does picking from it:
                choosing the one server again is how a phone reconnects. */}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                {managesServers()
                  ? "Switching closes every tab and reopens this machine's."
                  : "Paired with one server. Choose it again to reconnect."}
              </p>
              {managesServers() && (
                <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                  <Plus className="mr-1 size-3.5" />
                  Add Server…
                </Button>
              )}
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
  onRemove,
}: {
  status: ConnectionStatus;
  busy: boolean;
  onPick: (id: string) => void;
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
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
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
  onRemove,
}: {
  conn: ConnectionInfo;
  active: boolean;
  failed: string;
  busy: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const Icon = conn.destination === "" ? Laptop : Server;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active}
      disabled={busy}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60"
      onClick={onPick}
      onKeyDown={(e) => {
        // ⌫ on a focused row, the same remove verb the workspace strip uses.
        if (e.key !== "Backspace") return;
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
  );
}

// Step one asks for the address; step two shows what answered. Nothing is
// stored until the second step is accepted.
function AddConnection({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [probed, setProbed] = useState<Probed | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => firstRef.current?.focus(), []);

  const probe = async () => {
    setBusy(true);
    setError("");
    const res = await probeConnection(destination);
    setBusy(false);
    if (res.error) return setError(res.error);
    setProbed({ hostKey: res.hostKey, fingerprint: res.fingerprint, keyType: res.keyType });
  };

  const save = async (hostKey: string) => {
    setBusy(true);
    const res = await addConnection({ name, destination, keyPath, hostKey });
    setBusy(false);
    if (res.error) return setError(res.error);
    onAdded();
  };

  if (probed) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-[12px] leading-snug">
          {destination} answered with this {probed.keyType || "host"} key. Add it only if it matches what that
          machine reports for itself.
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
            It Matches, Add
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Field label="Name" value={name} onChange={setName} placeholder="Laptop" inputRef={firstRef} />
      <Field label="SSH destination" value={destination} onChange={setDestination} placeholder="dan@laptop" mono />
      <Field label="Key (optional)" value={keyPath} onChange={setKeyPath} placeholder="~/.ssh/ledge" mono />
      <p className="text-[11px] leading-snug text-muted-foreground">
        Any address ssh understands, including a name from your ~/.ssh/config. That machine needs Ledge&apos;s server
        on its PATH as <code className="font-mono">ledge-server</code>.
      </p>
      {error && <p className="text-[12px] leading-snug text-destructive">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy || !name.trim() || !destination.trim()} onClick={() => void probe()}>
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          Continue
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
        className={`rounded-md border border-input bg-transparent px-2 py-1 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}
