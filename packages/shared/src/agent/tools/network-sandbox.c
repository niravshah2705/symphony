/*
 * Execute a repository-native test command after installing a fail-closed
 * seccomp filter. The tester container intentionally shares its Cloud Run
 * service identity with its credential-injecting sidecar; untrusted repository
 * code must therefore be unable to create an internet/link-local socket and
 * reach the metadata server. AF_UNIX remains available for test runners' local
 * IPC. No capability, setuid bit, or user namespace is required.
 */
#include <errno.h>
#include <linux/seccomp.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void fail(const char *message) {
  perror(message);
  _exit(126);
}

static void deny_syscall_if_available(scmp_filter_ctx filter, const char *name) {
  int syscall_number = seccomp_syscall_resolve_name(name);
  if (syscall_number == __NR_SCMP_ERROR) {
    return;
  }
  if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), syscall_number, 0) < 0) {
    fail("network sandbox rule");
  }
}

int main(int argc, char **argv) {
  if (argc < 2 || argv[1] == NULL || argv[1][0] == '\0') {
    fputs("usage: ai-fleet-network-sandbox COMMAND [ARG ...]\n", stderr);
    return 126;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail("network sandbox no_new_privs");
  }

  scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
  if (filter == NULL) {
    fail("network sandbox init");
  }

  /* A fresh internet, packet, netlink, or raw socket is never permitted. */
  if (seccomp_rule_add(
        filter,
        SCMP_ACT_ERRNO(EPERM),
        SCMP_SYS(socket),
        1,
        SCMP_A0(SCMP_CMP_NE, AF_UNIX)) < 0) {
    fail("network sandbox socket rule");
  }
  if (seccomp_rule_add(
        filter,
        SCMP_ACT_ERRNO(EPERM),
        SCMP_SYS(socketpair),
        1,
        SCMP_A0(SCMP_CMP_NE, AF_UNIX)) < 0) {
    fail("network sandbox socketpair rule");
  }

  /* Close alternate ways to manufacture or steal a network descriptor. */
  deny_syscall_if_available(filter, "socketcall");
  deny_syscall_if_available(filter, "io_uring_setup");
  deny_syscall_if_available(filter, "io_uring_enter");
  deny_syscall_if_available(filter, "io_uring_register");
  deny_syscall_if_available(filter, "pidfd_open");
  deny_syscall_if_available(filter, "pidfd_getfd");
  deny_syscall_if_available(filter, "ptrace");
  deny_syscall_if_available(filter, "process_vm_readv");
  deny_syscall_if_available(filter, "process_vm_writev");

  if (seccomp_load(filter) < 0) {
    fail("network sandbox load");
  }
  seccomp_release(filter);

  execvp(argv[1], &argv[1]);
  fail("network sandbox exec");
  return 126;
}
