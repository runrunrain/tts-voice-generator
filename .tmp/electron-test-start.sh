#!/bin/bash
# Start Electron with remote debugging port for testing
cd /Users/maorun/maorun-workpace/tts-voice-generator

# Kill any existing processes
pkill -f "Electron.*tts-voice-generator" 2>/dev/null || true
pkill -f "electron.*main.cjs" 2>/dev/null || true
sleep 2

# Start Electron in background
npx electron --remote-debugging-port=9222 . &
ELECTRON_PID=$!
echo "ELECTRON_PID=$ELECTRON_PID"

# Wait for server to be ready
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "DevTools ready on port 9222"
    # Also check if the embedded server is up by looking at health
    # We need to find the actual server port from the Electron window
    echo "Checking for embedded server..."
    # The server port is dynamic (PORT=0), need to find it via CDP
    break
  fi
  sleep 1
done

echo "READY"
# Keep the script running so Electron stays alive
wait $ELECTRON_PID 2>/dev/null
