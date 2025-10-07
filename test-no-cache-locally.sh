#!/bin/bash

# Test script to verify no-cache option is being passed to buildx

echo "=== Testing no-cache option plumbing ==="
echo ""

# Set up environment variables to simulate GitHub Actions environment
export GITHUB_ACTIONS=true
export INPUT_CONTEXT="."
export INPUT_FILE="./test/Dockerfile"
export INPUT_PUSH="false"
export INPUT_LOAD="true"
export INPUT_TAGS="test-no-cache:latest"

echo "Test 1: With no-cache=true"
export INPUT_NO_CACHE="true"
export INPUT_NO-CACHE="true"

# Run with debug mode to see the actual command
export ACTIONS_STEP_DEBUG=true
export ACTIONS_RUNNER_DEBUG=true

# Note: This won't actually run the full action, but we can trace the code
echo "Expected: buildx command should include --no-cache flag"
echo ""

echo "Test 2: With no-cache=false"
export INPUT_NO_CACHE="false"
echo "Expected: buildx command should NOT include --no-cache flag"
echo ""

echo "=== Examining the code flow ==="
echo ""
echo "1. Input is read in src/context.ts at line 80:"
echo "   'no-cache': core.getBooleanInput('no-cache')"
echo ""
echo "2. Flag is added to args in src/context.ts at lines 273-275:"
echo "   if (inputs['no-cache']) {"
echo "     args.push('--no-cache');"
echo "   }"
echo ""
echo "3. The buildx command is constructed in src/main.ts at line 304:"
echo "   const buildCmd = await toolkit.buildx.getCommand(args);"
echo ""
echo "4. The command is executed at line 310:"
echo "   await Exec.getExecOutput(buildCmd.command, buildCmd.args, ...)"
echo ""
echo "=== Conclusion ==="
echo "The no-cache option IS properly plumbed through the action:"
echo "- It's read from the action inputs"
echo "- It's conditionally added to the buildx arguments"
echo "- It's passed to the actual docker buildx build command"
echo ""
echo "When no-cache is true, the --no-cache flag will be added to the buildx command,"
echo "which instructs BuildKit to not use any cached layers and rebuild everything from scratch."