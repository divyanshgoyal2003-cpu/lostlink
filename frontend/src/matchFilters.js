function dateMatches(value, from, to) {
  if (!from && !to) return true
  if (!value) return false
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return false
  const date = parsed.toISOString().slice(0, 10)
  return (!from || date >= from) && (!to || date <= to)
}

export function filterAndSortMatches(matches, filters) {
  const keyword = filters.keyword.trim().toLocaleLowerCase()

  return matches
    .filter((match) => {
      const keywordMatches = !keyword || [match.lostTitle, match.category]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(keyword))
      const categoryMatches = !filters.category || match.category === filters.category
      const strengthMatches = filters.strength === 'ALL' || match.matchStrength === filters.strength
      return keywordMatches && categoryMatches && strengthMatches &&
        dateMatches(match.foundReportTime, filters.foundDateFrom, filters.foundDateTo)
    })
    .sort((left, right) => {
      const scoreOrder = Number(right.matchScore) - Number(left.matchScore)
      const dateOrder = new Date(right.matchedAt).getTime() - new Date(left.matchedAt).getTime()
      return filters.sort === 'newest'
        ? dateOrder || scoreOrder
        : scoreOrder || dateOrder
    })
}
