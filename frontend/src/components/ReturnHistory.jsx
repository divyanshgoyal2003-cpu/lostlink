import { useCallback, useEffect, useState } from 'react'
import { getAuthorityCases, getMyClaims, getMyReturnHistory } from '../api'
import './ReturnHistory.css'

function ReturnHistory({ token }) {
  const [history, setHistory] = useState({ reports: [], claims: [], authorityCases: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    const [reportsResult, claimsResult, casesResult] = await Promise.allSettled([
      getMyReturnHistory(token),
      getMyClaims(token),
      getAuthorityCases(token, { history: true }),
    ])
    if (reportsResult.status === 'rejected' && claimsResult.status === 'rejected') {
      setError(reportsResult.reason?.message || claimsResult.reason?.message || 'Could not load return history.')
    }
    setHistory({
      reports: reportsResult.status === 'fulfilled' ? reportsResult.value.reports || [] : [],
      claims: claimsResult.status === 'fulfilled'
        ? (claimsResult.value.claims || []).filter((claim) => claim.claim_status === 'COMPLETED' && claim.current_user_relationship === 'CLAIMANT')
        : [],
      authorityCases: casesResult.status === 'fulfilled' ? casesResult.value.cases || [] : [],
    })
    setLoading(false)
  }, [token])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    window.addEventListener('lostlink:return-history-refresh', load)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('lostlink:return-history-refresh', load)
    }
  }, [load])

  const isEmpty = history.reports.length === 0 && history.claims.length === 0 && history.authorityCases.length === 0

  return (
    <section className="my-reports-section return-history" id="return-history" aria-labelledby="return-history-title">
      <div className="section-heading">
        <span className="section-kicker">COMPLETED RETURNS</span>
        <h2 id="return-history-title">Return history</h2>
        <p>Completed handovers are kept here for reference.</p>
      </div>
      {loading ? <p role="status">Loading return history…</p> : error ? (
        <div className="my-reports-empty"><p className="auth-error" role="alert">{error}</p><button className="btn btn-secondary" onClick={() => void load()}>Try again</button></div>
      ) : isEmpty ? <div className="my-reports-empty"><h3>No completed returns yet</h3><p>Items will appear here after a safe return is confirmed.</p></div> : (
        <div className="my-reports-list">
          {history.claims.map((claim) => (
            <article className="my-report-card return-history-card" key={`claim-${claim.claim_id}`}>
              <div className="my-report-card-top"><span className="report-type-badge">CLAIM #{claim.claim_id}</span><span className="my-report-status">RETURNED</span></div>
              <h3>{claim.current_user_relationship === 'CLAIMANT' ? 'This item was returned to you' : 'You confirmed the item was returned to its owner'}</h3>
              <p>Safe handover completed {new Date(claim.updated_at || claim.submitted_at).toLocaleString()}.</p>
              <p>Match #{claim.match_id}</p>
            </article>
          ))}
          {history.reports.map((report) => (
            <article className="my-report-card return-history-card" key={`report-${report.report_id}`}>
              <div className="my-report-card-top"><span className="report-type-badge">FOUND ITEM</span><span className="my-report-status">RETURNED</span></div>
              <h3>{report.title || 'Found item'}</h3>
              {report.category && <p>{report.category.replaceAll('_', ' ')}</p>}
              <p>{report.recovery_mode === 'AUTHORITY' ? `Handed to ${report.authority_name || 'the assigned authority'} and returned to its owner` : 'Returned to its owner'} · {new Date(report.updated_at || report.report_time).toLocaleString()}</p>
            </article>
          ))}
          {history.authorityCases.map((item) => (
            <article className="my-report-card return-history-card" key={`authority-${item.report_id}`}>
              <div className="my-report-card-top"><span className="report-type-badge">AUTHORITY CASE · {item.authority_name}</span><span className="my-report-status">RETURNED</span></div>
              <h3>{item.title || 'Found item'}</h3>
              <p>{item.category?.replaceAll('_', ' ') || 'Item'} · returned to its owner after custody</p>
              {item.received_at && <p>Received by authority {new Date(item.received_at).toLocaleString()}</p>}
              {item.updated_at && <p>Return recorded {new Date(item.updated_at).toLocaleString()}</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

export default ReturnHistory
