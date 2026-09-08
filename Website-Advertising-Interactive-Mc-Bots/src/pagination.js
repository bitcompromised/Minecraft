const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 25

// Generic filter+paginate over an in-memory array. `searchFn(item, term)`
// decides whether an item matches the (already-lowercased, trimmed) search
// term; omit `q` in the query to skip filtering entirely.
function paginateAndSearch(items, query, searchFn) {
  const term = typeof query?.q === 'string' ? query.q.trim().toLowerCase() : ''
  const filtered = term && searchFn ? items.filter((item) => searchFn(item, term)) : items

  const page = Math.max(1, parseInt(query?.page, 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query?.pageSize, 10) || DEFAULT_PAGE_SIZE))
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize

  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  }
}

module.exports = { paginateAndSearch, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE }
