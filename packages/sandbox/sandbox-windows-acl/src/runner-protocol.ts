/**
 * Argument used when a fixed Web runtime re-enters its own executable as the
 * Windows ACL runner. The argument is consumed by the Web entry before its
 * normal command-line parser sees the runner profile.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner-protocol
 */

/** Reserved executable argument that selects the Windows ACL runner entry. */
export const WINDOWS_ACL_RUNNER_ARG = '--dsh-windows-acl-runner'
