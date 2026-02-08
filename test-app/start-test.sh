#!/bin/bash
# Quick launcher for the Scryfall test page
# Usage: ./start-test.sh

echo "🃏 Scryfall Microservice Test Page Launcher"
echo "=========================================="
echo ""

# Check if server is running
if ! curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "⚠️  Proxxied server not running on port 3001"
    echo ""
    echo "Starting server..."
    cd ..
    npm run dev &
    SERVER_PID=$!
    echo "Server started (PID: $SERVER_PID)"
    echo "Waiting 5 seconds for server to initialize..."
    sleep 5
    cd test-app
else
    echo "✅ Server is running"
    SERVER_PID=""
fi

echo ""
echo "Opening test page in browser..."
echo ""

# Detect OS and open browser
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open scryfall-test.html 2>/dev/null || echo "Please open: $(pwd)/scryfall-test.html"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    open scryfall-test.html
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    start scryfall-test.html
else
    echo "Please open: $(pwd)/scryfall-test.html"
fi

echo ""
echo "📋 Test Page Ready!"
echo ""
echo "Example queries loaded:"
echo "  1. f:commander otag:typal-human t:creature -t:human"
echo "  2. c:red t:instant cmc:1"
echo "  3. t:planeswalker c>=3"
echo "  4. o:\"draw a card\" t:creature pow>=4"
echo "  5. f:standard -c:w -c:u -c:b -c:r -c:g"
echo "  6. year>=2023 r:mythic"
echo ""
echo "Press Ctrl+C to stop"

# Keep script running if we started the server
if [ -n "$SERVER_PID" ]; then
    trap "echo ''; echo 'Stopping server...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM
    wait $SERVER_PID
fi
