The sandbox profile starts from Moby v28.0.4's default deny-by-default profile:
https://github.com/moby/moby/blob/v28.0.4/profiles/seccomp/default.json
Upstream SHA256: 9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76

It adds unshare/mount/umount2/pivot_root/setns for unprivileged bubblewrap setup,
and clone only when CLONE_NEWUSER is set. Kernel namespace/capability checks
still apply. Compose keeps UID 10001, no-new-privileges, all capabilities dropped,
and a read-only root. Only web (Office validation) and conversion use this profile.
This explicit container policy change was approved by the operator on 2026-11-04.
