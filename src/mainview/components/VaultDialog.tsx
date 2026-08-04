// The vault passphrase dialog (locking.md §7): one component, two faces
// decided by the mirrored vault state — UNLOCK (a vault exists: one field,
// wrong-passphrase shakes and stays) and SETUP (first lock ever: passphrase
// twice, and the no-recovery sentence said out loud, once, where it cannot be
// missed). The dialog is only the passphrase prompt: what happens next (lock
// the note the user was reaching for, open the remove-lock confirm) is App's
// follow-up via onUnlocked — the dialog neither knows nor cares.
//
// The field clears on close regardless of outcome, and the passphrase goes
// nowhere but the one RPC (vault/channel.ts): no state, no echo, no log.
import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushLayer } from "@/commands/layers";
import { changeVaultPassphrase, createVault, unlockVault, useVaultState } from "@/vault/channel";

export function VaultDialog({
  mode = "auto",
  onClose,
  onUnlocked,
  onNotice,
}: {
  // "auto" is the unlock/setup pair (by vault state); "change" is the
  // Change Vault Passphrase… face — new passphrase twice, unlocked only.
  mode?: "auto" | "change";
  onClose: () => void;
  onUnlocked: () => void;
  onNotice?: (message: string) => void;
}) {
  const state = useVaultState();
  const change = mode === "change";
  const setup = !change && state === "none";
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passRef.current?.focus();
  }, []);

  // A dialog layer like confirm and the profile editor (interactions.md §6):
  // Escape addresses this, topmost-only; the window keymap sleeps under it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => pushLayer("dialog", () => onCloseRef.current()), []);

  const submit = async () => {
    if (busy) return;
    if (pass.length === 0) {
      setProblem("Enter a passphrase.");
      return;
    }
    if ((setup || change) && pass !== confirm) {
      setProblem("The passphrases don't match.");
      return;
    }
    setBusy(true);
    try {
      if (change) {
        const res = await changeVaultPassphrase(pass);
        if (!res.ok) {
          setProblem("Could not change the passphrase.");
          return;
        }
        onNotice?.(`Passphrase changed; ${res.rewrapped} locked ${res.rewrapped === 1 ? "item" : "items"} rewrapped.`);
        onClose();
        return;
      }
      const ok = setup ? await createVault(pass) : await unlockVault(pass);
      if (!ok) {
        // Wrong passphrase (or a create race): shake, clear, stay — the
        // classic grammar, and the field never holds a wrong guess.
        setProblem(setup ? "Could not create the vault." : "Wrong passphrase.");
        setPass("");
        setConfirm("");
        setShake(true);
        setTimeout(() => setShake(false), 350);
        passRef.current?.focus();
        return;
      }
      onUnlocked();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={setup ? "Lock Notes" : "Unlock Notes"}
        data-testid="vault-dialog"
        className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl"
        // Tailwind has no shake; a three-keyframe inline animation is less
        // machinery than a css file entry for one dialog.
        style={shake ? { animation: "ledge-shake 0.3s ease-in-out" } : undefined}
      >
        <style>{`@keyframes ledge-shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-6px) } 75% { transform: translateX(6px) } }`}</style>
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            {change ? "Change Vault Passphrase" : setup ? "Lock Notes" : "Unlock Notes"}
          </h2>
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          {change
            ? "Every locked note and sealed image is rewrapped under the new passphrase; the old one stops working everywhere. There is still no recovery."
            : setup
              ? "Choose the passphrase that locks and unlocks your locked notes. There is no recovery: a forgotten passphrase is the locked notes, gone. Title and front matter are not encrypted."
              : "Enter your vault passphrase."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={passRef}
            type="password"
            value={pass}
            placeholder={change ? "New passphrase" : "Passphrase"}
            autoComplete="off"
            onChange={(e) => {
              setPass(e.target.value);
              setProblem(null);
            }}
            className="mt-3 w-full rounded border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
          />
          {(setup || change) && (
            <input
              type="password"
              value={confirm}
              placeholder="Repeat passphrase"
              autoComplete="off"
              onChange={(e) => {
                setConfirm(e.target.value);
                setProblem(null);
              }}
              className="mt-2 w-full rounded border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring touch:min-h-[44px]"
            />
          )}
          {problem && <p className="mt-2 text-[12px] text-destructive">{problem}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {change ? "Change Passphrase" : setup ? "Create Vault" : "Unlock"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
