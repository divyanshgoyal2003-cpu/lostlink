
import { useEffect, useState } from 'react'
import {
  Circle,
  MapContainer,
  Marker,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const DEFAULT_CENTER = [20.5937, 78.9629]

function MapUpdater({ position }) {
  const map = useMap()

  useEffect(() => {
    if (position) {
      map.flyTo(position, Math.max(map.getZoom(), 15))
    }
  }, [map, position])

  return null
}

function MapClickHandler({ onLocationSelect }) {
  useMapEvents({
    click(event) {
      onLocationSelect({
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
      })
    },
  })

  return null
}

export default function LocationPicker({
  latitude,
  longitude,
  uncertaintyRadiusM = 75,
  onLocationChange,
  onRadiusChange,
}) {
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')

  const hasLocation =
    latitude !== '' &&
    longitude !== '' &&
    Number.isFinite(Number(latitude)) &&
    Number.isFinite(Number(longitude)) &&
    Number(latitude) >= -90 &&
    Number(latitude) <= 90 &&
    Number(longitude) >= -180 &&
    Number(longitude) <= 180

  const position = hasLocation
    ? [Number(latitude), Number(longitude)]
    : null

  const markerIcon = L.divIcon({
    className: 'lostlink-map-marker',
    html: '<span></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })

  async function handleSearch() {

    const query = searchText.trim()

    if (!query) {
      setSearchError('Enter a place, landmark, street, or address.')
      setSearchResults([])
      return
    }

    setSearchLoading(true)
    setSearchError('')
    setSearchResults([])

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '5',
      })

      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { Accept: 'application/json' } }
      )

      if (!response.ok) {
        throw new Error(
          'Location search is temporarily unavailable. Please try again.'
        )
      }

      const results = await response.json()
      setSearchResults(results)

      if (results.length === 0) {
        setSearchError(
          'No locations found. Try a more specific place or address.'
        )
      }
    } catch (error) {
      setSearchError(
        error.message || 'Could not search for that location.'
      )
    } finally {
      setSearchLoading(false)
    }
  }

  function selectSearchResult(result) {
    onLocationChange({
      latitude: Number(result.lat),
      longitude: Number(result.lon),
    })

    setSearchText(result.display_name)
    setSearchResults([])
    setSearchError('')
  }

  return (
    <div className="location-picker">
      
<div className="location-search-form">
  <label htmlFor="location-search">
    Search for a location
  </label>

  <div className="location-search-row">
    <input
      id="location-search"
      type="search"
      value={searchText}
      onChange={(event) => setSearchText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          handleSearch()
        }
      }}
      placeholder="e.g. VIT Vellore, Chennai Central..."
      maxLength={200}
    />

    <button
      className="btn btn-primary"
      type="button"
      onClick={handleSearch}
      disabled={searchLoading}
    >
      {searchLoading ? 'Searching...' : 'Search'}
    </button>
  </div>

  <p className="location-picker-help">
    Enter a place or address and press Search. Choose a result
    to move the map to that location.
  </p>
</div>


      {searchError && (
        <p className="location-search-message" role="status">
          {searchError}
        </p>
      )}

      {searchResults.length > 0 && (
        <div className="location-search-results" aria-label="Search results">
          {searchResults.map((result) => (
            <button
              className="location-search-result"
              type="button"
              key={`${result.osm_type}-${result.osm_id}`}
              onClick={() => selectSearchResult(result)}
            >
              <span className="location-result-icon">⌖</span>
              <span>{result.display_name}</span>
            </button>
          ))}
        </div>
      )}

      <p className="location-picker-help">
        You can also click anywhere on the map to choose a location
        or adjust the marker.
      </p>

      <MapContainer
        center={position || DEFAULT_CENTER}
        zoom={position ? 15 : 5}
        scrollWheelZoom
        className="location-picker-map"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapClickHandler onLocationSelect={onLocationChange} />

        {position && (
          <>
            <Marker position={position} icon={markerIcon} />
            <Circle
              center={position}
              radius={uncertaintyRadiusM}
              pathOptions={{
                color: '#2563eb',
                fillColor: '#60a5fa',
                fillOpacity: 0.2,
              }}
            />
          </>
        )}

        <MapUpdater position={position} />
      </MapContainer>

      <div className="location-picker-details">
        <p>
          <strong>Selected location:</strong>{' '}
          {hasLocation
            ? `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`
            : 'Search or click the map to choose a location'}
        </p>

        <label htmlFor="uncertainty-radius">
          Location uncertainty: {uncertaintyRadiusM} metres
        </label>

        <input
          id="uncertainty-radius"
          type="range"
          min="25"
          max="1000"
          step="25"
          value={uncertaintyRadiusM}
          onChange={(event) =>
            onRadiusChange(Number(event.target.value))
          }
        />

        <div className="location-radius-labels">
          <span>25 m — More precise</span>
          <span>1,000 m — Less precise</span>
        </div>
      </div>
    </div>
  )
}
