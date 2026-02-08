# Scryfall Microservice Test Page

A standalone HTML test page for verifying complex Scryfall query handling by the Proxxied microservice.

## 🚀 Quick Start

1. **Start the Proxxied server:**
   ```bash
   cd .. && npm run dev
   ```

2. **Open the test page:**
   - Simply open `scryfall-test.html` in your browser
   - Or use a local server: `python3 -m http.server 8000`
   - Navigate to: `http://localhost:8000/scryfall-test.html`

## 🎯 Features

- **Visual Card Grid**: Scryfall-like card display with hover effects
- **Card Details Modal**: Click any card for full details
- **Pre-loaded Examples**: 6 complex query examples ready to test
- **Real-time Status**: Shows query time and result count
- **Error Handling**: Clear error messages with troubleshooting hints
- **Keyboard Shortcuts**: 
  - `Enter` to search
  - `Esc` to close modal

## 📋 Example Queries Included

### 1. Commander Human Tribal (User's Original Query)
```
f:commander otag:typal-human t:creature -t:human
```
Tests: Format filter, oracle tags, type inclusion/exclusion

### 2. Red 1-CMC Instants
```
c:red t:instant cmc:1
```
Tests: Color filter, type filter, CMC filter

### 3. 3+ Color Planeswalkers
```
t:planeswalker c>=3
```
Tests: Type filter, color identity comparison

### 4. Card Draw Creatures (4+ Power)
```
o:"draw a card" t:creature pow>=4
```
Tests: Oracle text search, type filter, power comparison

### 5. Standard Colorless
```
f:standard -c:w -c:u -c:b -c:r -c:g
```
Tests: Format filter, multiple color exclusions

### 6. Recent Mythics (2023+)
```
year>=2023 r:mythic
```
Tests: Year comparison, rarity filter

## 🔧 Technical Details

**API Endpoint**: `http://localhost:3001/api/scryfall/search`

**Request Format**:
```javascript
GET /api/scryfall/search?q=<encoded-query>
```

**Response Format** (Expected):
```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "name": "Card Name",
      "mana_cost": "{1}{W}",
      "type_line": "Creature — Human Soldier",
      "oracle_text": "...",
      "image_uris": { "normal": "...", "png": "..." },
      ...
    }
  ]
}
```

## 🧪 Testing Checklist

Use this page to verify:

- [x] Complex query parsing (multiple filters)
- [x] Format filters (`f:commander`, `f:standard`)
- [x] Oracle tags (`otag:typal-human`)
- [x] Type inclusion/exclusion (`t:creature`, `-t:human`)
- [x] Color filters (`c:red`, `-c:w`)
- [x] Comparisons (`cmc:1`, `pow>=4`, `year>=2023`)
- [x] Oracle text search (`o:"draw a card"`)
- [x] Rarity filters (`r:mythic`)
- [x] Response time tracking
- [x] Error handling (malformed queries)

## 🐛 Troubleshooting

**Cards not loading?**
- Ensure Proxxied server is running on port 3001
- Check browser console for CORS errors
- Verify microservice is available at `http://localhost:8080`

**"Search failed" error?**
- Check query syntax (Scryfall query syntax required)
- View Network tab in browser DevTools for detailed error

**Slow response?**
- First query may be slow (cache warming)
- Subsequent queries should be faster (~100-500ms)

## 📊 Performance Expectations

| Scenario | Expected Response Time |
|----------|----------------------|
| First query (cache miss) | 500-2000ms |
| Cached query | 10-50ms |
| Complex query (50+ results) | 200-800ms |
| Error (invalid query) | <100ms |

## 🎨 Design Notes

Built as a standalone HTML file for:
- Zero dependencies
- No build process
- Instant testing
- Easy sharing

UI inspired by Scryfall's clean, card-focused design with modern gradients and smooth animations.
