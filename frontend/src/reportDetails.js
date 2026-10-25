const PRIVATE_ATTRIBUTE_KEY_PATTERN = /(password|token|secret|credential|api.?key|storage|photo|proof|evidence|serial|identifier|holder|reviewer|verification|private)/i

export function formatReportDetailValue(value) {
  if (value === null || value === undefined || value === '') return 'Not provided'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatDate(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString()
}

export function getReportDetailSections(report) {
  const attributes = report.item_attributes && typeof report.item_attributes === 'object'
    ? report.item_attributes
    : {}
  const customAttributes = Object.entries(attributes)
    .filter(([key]) => !['company', 'model'].includes(key.toLowerCase()))
    .filter(([key]) => !PRIVATE_ATTRIBUTE_KEY_PATTERN.test(key))
    .map(([key, value]) => ({
      label: key.replaceAll('_', ' '),
      value: formatReportDetailValue(value),
    }))

  return [
    {
      title: 'Item Details',
      fields: [
        { label: 'Title', value: report.title || report.item_title },
        { label: 'Category', value: report.category?.replaceAll('_', ' ') },
        { label: 'Description', value: report.description },
        { label: 'Colour', value: report.color },
        { label: 'Brand', value: report.company || attributes.company },
        { label: 'Model', value: attributes.model },
        ...customAttributes,
      ],
    },
    {
      title: 'Location Details',
      fields: [
        { label: 'Location description', value: report.location_description },
        { label: 'Latitude', value: report.latitude },
        { label: 'Longitude', value: report.longitude },
        { label: 'Uncertainty radius', value: report.uncertainty_radius_m == null ? null : `${report.uncertainty_radius_m} m` },
        { label: 'Location accuracy', value: report.location_accuracy_m == null ? null : `${report.location_accuracy_m} m` },
        { label: 'Location source', value: report.location_source?.replaceAll('_', ' ') },
      ],
    },
    {
      title: 'Report Information',
      fields: [
        { label: 'Report ID', value: report.report_id },
        { label: 'Report type', value: report.report_type },
        { label: 'Status', value: report.status?.replaceAll('_', ' ') || 'OPEN' },
        { label: 'Reported date and time', value: formatDate(report.report_time) },
        { label: 'Submitted date and time', value: formatDate(report.created_at) },
        { label: 'Recovery plan', value: report.recovery_mode?.replaceAll('_', ' ') },
        { label: 'Assigned authority', value: report.authority_name },
        { label: 'Custody status', value: report.custody_status?.replaceAll('_', ' ') },
        { label: 'Custody initiated', value: formatDate(report.custody_initiated_at) },
        { label: 'Custody received', value: formatDate(report.custody_received_at) },
      ],
    },
  ].map((section) => ({
    ...section,
    fields: section.fields.map((field) => ({
      ...field,
      value: formatReportDetailValue(field.value),
    })),
  }))
}

export function reportDetailsReducer(_state, action) {
  if (action.type === 'open') return action.report
  if (action.type === 'close') return null
  return _state
}

export function activateReportDetails(event, report, onOpen) {
  event.stopPropagation()
  onOpen(report, event.currentTarget)
}

export function handleReportDetailsKeyDown(event, onClose) {
  if (event.key === 'Escape') {
    event.preventDefault()
    onClose()
  }
}
