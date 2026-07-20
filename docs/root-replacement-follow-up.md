# Root-replacement recovery follow-up

Status: separate future design milestone; not implemented by manual or
automatic reconciliation.

Recovery cannot mean “watch whatever now occupies the same string path.” A
future design must choose and expose whether replacement identity is acceptable
at all, how the original `(device, inode)` loss and new identity are reported,
and whether an ancestor replacement differs from replacement of the direct
root. It must reject every symlink component again and prevent path
normalization from erasing a symlink/`..` ancestry before validation.

If reattachment is allowed, it must install or share each directory watch
before reading that directory, validate the candidate root identity before and
after traversal, and conservatively cover mutations across the identity and
scan barriers. The committed exclusion generation must remain fixed through
the transaction; current and future excluded prefixes must never be traversed
or delivered, and an exclusion update must retain an explicit conflict rather
than being silently reordered.

The lifecycle contract also needs a single serialized replacement transaction,
bounded traversal/output, truthful partial or uncertain failure, and joined
disposal that interrupts the transaction and prevents later enqueue or callback
entry. Success would need a distinct public identity/replacement result and one
conservative boundary; it must not reconstruct detailed events from the gap.
Until those questions are resolved, `root-replaced` stays sticky,
`reconcile()` rejects it, and automatic reconciliation reports `blocked`.
