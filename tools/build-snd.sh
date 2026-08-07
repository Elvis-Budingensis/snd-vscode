#!/bin/sh
# build-snd.sh -- build the headless Snd this extension drives.
#
# WHAT THIS AVOIDS.  Installing Snd is painful on macOS and Windows because
# of MOTIF: XQuartz, libXm, libXt, libXpm, headers wherever Homebrew put
# them this year.  None of that is needed here.  Snd's own configure
# defaults to no GUI -- Motif is only used with --with-motif -- and the
# headless build has no X dependency at all.  sndlib and s7 are in the
# tarball; the audio backend on macOS is CoreAudio, which is part of the
# system.
#
# So the whole build is ./configure && make, with a C compiler and nothing
# else.  Two minutes, no third-party libraries, and the part that is being
# skipped is exactly the part this extension replaces.
#
# Usage:
#   tools/build-snd.sh                       # fetch snd-26.5 and build it
#   tools/build-snd.sh /path/to/snd-26.5     # build a source tree you have
#
# The binary lands in bin/<platform>-<arch>/snd, which is where the
# extension looks before it looks at PATH.

set -e

VERSION=26.5
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK="$ROOT/.build"
SOURCE="$1"

# ROOT is derived from where this script sits, which means it has to sit in
# the project's tools/ directory. Run as a loose copy somewhere else, the
# build lands outside the project, the binary is put where the extension
# will not look for it, and the bridge check at the end fails on a path that
# does exist -- in the repository.
if [ ! -f "$ROOT/scheme/snd-vscode.scm" ]; then
  echo "This script expects to be in the project's tools/ directory."
  echo "  looked for: $ROOT/scheme/snd-vscode.scm"
  echo "Unpack the archive and run tools/build-snd.sh from inside it."
  exit 2
fi

case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win32 ;;
  *) echo "unknown platform: $(uname -s)"; exit 2 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) ARCH=$(uname -m) ;;
esac

TARGET="$ROOT/bin/$PLATFORM-$ARCH"

if [ -z "$SOURCE" ]; then
  mkdir -p "$WORK"
  SOURCE="$WORK/snd-$VERSION"
  if [ ! -d "$SOURCE" ]; then
    echo "== fetching snd-$VERSION"
    # ccrma.stanford.edu is the only distribution point; the tarball has no
    # checksum published alongside it, so there is nothing honest to verify
    # against here. If that matters to you, download it yourself and pass
    # the directory as an argument.
    curl -fL "https://ccrma.stanford.edu/software/snd/snd-$VERSION.tar.gz" \
      -o "$WORK/snd-$VERSION.tar.gz"
    tar xzf "$WORK/snd-$VERSION.tar.gz" -C "$WORK"
  fi
fi

if [ ! -f "$SOURCE/configure" ]; then
  echo "not a Snd source tree: $SOURCE"
  exit 2
fi

# ---------------------------------------------------------------------
# The toolchain environment
#
# "configure: error: cannot run C compiled programs" on macOS almost always
# means the compiler worked and the a.out did not run -- and on Apple
# silicon the usual reason is a conda environment.  conda puts its own
# linker wrappers on PATH, sets CC, CFLAGS, LDFLAGS and SDKROOT for ITS
# sysroot, and adds $CONDA_PREFIX/lib to the library path.  The test
# program then links against conda's libraries and cannot start.  configure
# reports this as a broken compiler, which sends everybody looking in the
# wrong place.
#
# So the build runs with the system toolchain unless asked otherwise. Not
# silently: a build that quietly ignores the environment someone set up is
# its own kind of problem, so it says what it dropped.
# ---------------------------------------------------------------------

if [ "${SND_KEEP_ENV:-0}" != "1" ]; then
  DROPPED=""
  for var in CC CXX CPP LD CFLAGS CXXFLAGS CPPFLAGS LDFLAGS SDKROOT \
             CONDA_BUILD_SYSROOT MACOSX_DEPLOYMENT_TARGET \
             DYLD_LIBRARY_PATH LD_LIBRARY_PATH PKG_CONFIG_PATH; do
    eval "value=\$$var"
    if [ -n "$value" ]; then
      DROPPED="$DROPPED $var"
      unset "$var"
    fi
  done

  # PATH entries belonging to conda, miniforge, homebrew's llvm and the
  # like. Keeping the rest means a hand-installed compiler still wins if it
  # is somewhere ordinary.
  CLEAN_PATH=""
  OLD_IFS=$IFS
  IFS=:
  for entry in $PATH; do
    case "$entry" in
      *conda*|*miniforge*|*mambaforge*|*anaconda*) DROPPED="$DROPPED PATH:$entry" ;;
      *) CLEAN_PATH="${CLEAN_PATH:+$CLEAN_PATH:}$entry" ;;
    esac
  done
  IFS=$OLD_IFS
  PATH="${CLEAN_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  export PATH

  if [ -n "$DROPPED" ]; then
    echo "== ignoring for this build:$DROPPED"
    echo "   (SND_KEEP_ENV=1 to keep them)"
  fi
fi

# ---------------------------------------------------------------------
# WHICH COMPILER
#
# configure looks for `gcc` first and only falls back to `cc`.  On macOS
# `gcc` is normally a shim for Apple clang, so that costs nothing -- but if
# a real GCC is installed (Homebrew, conda, a toolchain someone needed once)
# it is found instead, and a GCC that predates the current SDK produces
# binaries that will not start.  configure then says "cannot run C compiled
# programs", which sounds like a broken machine and is really a compiler
# preference.
#
# It cost an afternoon here: `cc` was Apple clang 17 and worked perfectly,
# `gcc` was GCC 12.2.0 and did not, and every check that used `cc` came back
# green while configure kept failing.
#
# So on macOS the compiler is named explicitly, and it is the one Xcode
# installed.  Anywhere else, whatever configure finds is right.
# ---------------------------------------------------------------------

if [ -z "${CC:-}" ] && [ "$PLATFORM" = darwin ] && [ -x /usr/bin/clang ]; then
  CC=/usr/bin/clang
  export CC
  echo "== compiler: $CC (Apple clang, in preference to whatever gcc is)"
  if command -v gcc >/dev/null 2>&1; then
    GCC_VERSION=$(gcc --version 2>/dev/null | head -1)
    case "$GCC_VERSION" in
      *clang*) : ;;   # the usual shim, nothing to say
      *) echo "   note: gcc here is \"$GCC_VERSION\" -- not used" ;;
    esac
  fi
fi

# The check configure is about to make, made here where the answer is
# readable. configure reports a failure at this point as "cannot run C
# compiled programs", which describes the symptom and not the cause.
#
# THE PROBE RUNS IN THE SOURCE DIRECTORY, not in a temporary one.  That is
# the whole point and it was wrong here once: a probe in /tmp passes on a
# machine where cc is perfect and configure still fails, because what
# configure cannot do is run a binary IN ITS OWN BUILD DIRECTORY.  A green
# probe followed by the same red configure is worse than no probe -- it
# rules out the actual cause.
#
# Reasons a binary will not run from a particular directory, all real: the
# volume is mounted noexec (an external disk, a network share, some
# encrypted containers); the directory lost its execute bit when tar
# unpacked it; the files carry com.apple.quarantine from the download; the
# path is inside a location macOS guards.
echo "== checking the compiler where the build will happen"
PROBE="$SOURCE/.snd-vscode-probe"
mkdir -p "$PROBE"
cat > "$PROBE/probe.c" <<'PROBE_EOF'
#include <stdio.h>
int main(void) { printf("ok\n"); return 0; }
PROBE_EOF
# ${CC:-cc}, not cc: the probe has to use the compiler CONFIGURE will use,
# or it answers a question nobody asked. That was the bug above -- cc was
# fine, gcc was not, and the probe kept saying yes.
if ! (cd "$PROBE" && "${CC:-cc}" probe.c -o probe 2>probe.log); then
  echo "${CC:-cc} could not compile a hello world:"
  cat "$PROBE/probe.log"
  echo
  echo "On macOS: xcode-select --install"
  rm -rf "$PROBE"
  exit 1
fi
if ! (cd "$PROBE" && ./probe >/dev/null 2>probe.run.log); then
  echo
  echo "The compiler works, but its output will not RUN from"
  echo "  $SOURCE"
  echo "This is exactly what configure calls 'cannot run C compiled programs'."
  echo
  cat "$PROBE/probe.run.log" 2>/dev/null
  echo "-- what this directory looks like:"
  ls -ld "$SOURCE"
  case "$(uname -s)" in
    Darwin)
      # Each of these has a different fix, so each is reported rather than
      # guessed at.
      MOUNT_POINT=$(df "$SOURCE" | awk 'NR==2 {print $NF}')
      echo "-- volume: $MOUNT_POINT"
      mount | grep -F " on $MOUNT_POINT " || true
      if mount | grep -F " on $MOUNT_POINT " | grep -q noexec; then
        echo
        echo ">> The volume is mounted noexec. Nothing can be executed from it."
        echo "   Build somewhere on the system disk:"
        echo "     tools/build-snd.sh ~/snd-src/snd-26.5"
      fi
      if xattr -l "$SOURCE" 2>/dev/null | grep -q quarantine; then
        echo
        echo ">> The source tree carries com.apple.quarantine from the download."
        echo "   Remove it and try again:"
        echo "     xattr -dr com.apple.quarantine \"$SOURCE\""
      fi
      ;;
    *)
      df "$SOURCE" | tail -1
      ;;
  esac
  echo
  echo "If none of the above applies, the answer is in config.log after a"
  echo "configure run -- look for 'Permission denied', 'Bad CPU type' or 'dyld'."
  rm -rf "$PROBE"
  exit 1
fi
rm -rf "$PROBE"
echo "   ${CC:-cc} works, and its output runs from the build directory"

echo "== configuring (headless: no --with-motif, so no X at all)"
cd "$SOURCE"
# --with-s7 is the default and stated anyway, because the bridge is s7
# Scheme and a Ruby or Forth build would load nothing.
# A stale config.cache from a failed attempt keeps reporting the failure.
rm -f config.cache
./configure --with-s7 ${CC:+CC="$CC"} >configure.log 2>&1 || {
  tail -20 configure.log
  echo
  # config.log holds the actual compiler and linker output; configure.log
  # holds only its own summary of it. The cause is almost always in the
  # first one and almost never in the second.
  if [ -f config.log ]; then
    echo "-- from config.log, where the real error is:"
    grep -B3 -A12 -m1 -E 'error:|cannot run|dyld|Library not loaded' config.log || tail -30 config.log
  fi
  echo
  echo "configure failed -- full output in $SOURCE/configure.log and config.log"
  exit 1
}

# The check that matters. If Motif got picked up anyway -- because
# --with-gui was in a CONFIG_SITE, or an old config.cache is lying around --
# the build needs X and the binary needs a display, and the failure comes
# much later and looks like something else.
if grep -q '^GX_FILES *= *snd-motif' Makefile 2>/dev/null || \
   grep -qi 'lXm' Makefile 2>/dev/null; then
  echo "configure chose Motif. This build wants no GUI."
  echo "Remove config.cache and any CONFIG_SITE, then try again."
  exit 1
fi

echo "== building"
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)" >build.log 2>&1 || {
  tail -40 build.log
  echo "make failed -- its full output is in $SOURCE/build.log"
  exit 1
}

if [ ! -x ./snd ]; then
  echo "no snd binary was produced"
  exit 1
fi

mkdir -p "$TARGET"
cp ./snd "$TARGET/snd"

echo "== checking that it runs and speaks the protocol"
# Not just --version: the thing to know is whether the BRIDGE loads and
# reports itself, because that is what the extension waits for. Feeding it
# EOF makes the headless bridge shut Snd down by itself.
if printf '' | "$TARGET/snd" -l "$ROOT/scheme/snd-vscode.scm" 2>&1 | \
   grep -q '"event":"ready"'; then
  echo
  echo "ok: $TARGET/snd"
  echo "The extension prefers this over anything on PATH."
else
  echo
  echo "The binary was built but did not report itself ready."
  echo "Run it by hand to see why:"
  echo "  $TARGET/snd -l $ROOT/scheme/snd-vscode.scm"
  exit 1
fi

echo "== index"
cd "$ROOT"
node tools/make-index.mjs "$SOURCE"
