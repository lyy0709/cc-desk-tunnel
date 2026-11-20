// Writable native state is also consumed by the broker. A CLI must not plant links into
// that state or inspect another launch's process environment. The runner has already
// dropped its supervisor identity before executing this program.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
static const uint64_t read_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
static void fail(const char *name) { perror(name); exit(126); }
static void allow(int rules, const char *path, uint64_t access, int optional) {
  if (!path) { errno = EINVAL; fail("missing runtime path"); }
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) { if (optional && errno == ENOENT) return; fail(path); }
  struct stat st;
  if (fstat(fd, &st)) fail(path);
  if (!S_ISDIR(st.st_mode)) access &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr entry = {.allowed_access = access, .parent_fd = fd};
  if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &entry, 0)) fail(path);
  close(fd);
}
static void allow_child(int rules, const char *dir, const char *name, uint64_t access, int optional) {
  char path[PATH_MAX];
  if (snprintf(path, sizeof(path), "%s/%s", dir, name) >= (int)sizeof(path)) exit(126);
  allow(rules, path, access, optional);
}
int main(int argc, char **argv) {
  if (syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < 3) {
    fputs("CC runtime requires Linux Landlock ABI 3 or newer.\n", stderr);
    return 126;
  }
  if (argc == 2 && !strcmp(argv[1], "--check")) return 0;
  if (argc < 2 || geteuid() == 0) return 126;
  const uint64_t all = (LANDLOCK_ACCESS_FS_TRUNCATE << 1) - 1;
  const uint64_t shared = read_access | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE |
    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_REFER;
  struct landlock_ruleset_attr policy = {.handled_access_fs = all};
  int rules = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
  if (rules < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("CC runtime isolation");
  const char *system[] = {"/bin","/usr","/lib","/lib64","/etc","/opt/runtime","/app","/proc/self",
    "/proc/stat","/proc/cpuinfo","/proc/meminfo","/proc/sys/kernel/osrelease",NULL};
  for (int i=0; system[i]; ++i) allow(rules, system[i], read_access, 1);
  const char *base = strrchr(argv[0], '/');
  if (!strcmp(base ? base + 1 : argv[0], "ccdt-project-mcp")) {
    // Stack a read-only policy before loading Node or any MCP dependency. Keep only stdio and the
    // session socket (access to that socket is controlled by the worker-assigned Unix group).
    allow(rules, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
    if (syscall(SYS_landlock_restrict_self, rules, 0)) fail("project MCP isolation");
    close(rules);
    char *const env[] = {"PATH=/opt/runtime/node/bin:/usr/bin:/bin", "LANG=C.UTF-8", NULL};
    execve("/opt/runtime/node/bin/node", argv, env);
    fail("project MCP executable");
  }
  allow(rules, argv[1], read_access, 0);
  allow(rules, "/tmp", all, 0);
  allow(rules, "/dev", read_access | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
  allow(rules, ".", shared, 0);
  const char *config = getenv("CCDT_SHARED_CONFIG");
  if (!config) return 126;
  allow_child(rules, config, "settings.json", read_access, 1);
  allow_child(rules, config, "CLAUDE.md", read_access, 1);
  if (getenv("CCDT_HISTORY")) allow(rules, getenv("CCDT_HISTORY"), shared, 0);
  allow(rules, getenv("HOME"), shared, 0);
  const char *terminal = getenv("CCDT_TERMINAL");
  if (terminal) {
    allow_child(rules, terminal, "settings.json", LANDLOCK_ACCESS_FS_READ_FILE, 0);
    allow_child(rules, terminal, "events", shared, 0);
  }
  // Existing filesystem sockets can be connected to under their Unix group permissions.
  if (syscall(SYS_landlock_restrict_self, rules, 0)) fail("CC runtime isolation");
  close(rules);
  execv(argv[1], argv+1);
  fail("CC runtime executable");
}
