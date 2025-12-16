// Dashboard UI and Charting Logic
// Note: Expects jQuery, DataTables, Chart.js, and utility modules to be loaded first

let worldMap;

// Helper function to get IP lookup (from api-utils.js module)
async function getUserLocation() {
    try {
        const response = await fetch('/api/v1/geolocation');
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        const data = await response.json();
        console.log('User\'s Location Data is ', data);
        console.log('User\'s Country', data.country);
        return data;
    } catch (error) {
        console.error('Failed to fetch user location:', error);
        throw error;
    }
}

// Helper function to initialize SSE feed
function initializeFeed(onNewEvent) {
    const privateUrl = '/api/v1/feed/events/private';
    const publicUrl = '/api/v1/feed/events';

    const iconMap = {
        info: 'fa-info-circle',
        warning: 'fa-exclamation-triangle',
        error: 'fa-bell',
        success: 'fa-check-circle',
        user: 'fa-user',
        device: 'fa-share-alt',
        userLog: 'fa-eye'
    };

    const colorMap = {
        info: 'info',
        warning: 'warning',
        error: 'danger',
        success: 'success',
        user: 'primary',
        device: 'success',
        userLog: 'primary'
    };

    const timeAgo = (ts) => {
        const then = ts ? new Date(ts).getTime() : Date.now();
        const diff = Math.floor((Date.now() - then) / 1000);
        if (diff < 10) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        const mins = Math.floor(diff / 60);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const normalize = (data) => {
        return {
            message: data.message || 'Event occurred',
            icon: iconMap[data.type] || iconMap.info,
            color: colorMap[data.type] || colorMap.info,
            timeAgo: timeAgo(data.timestamp),
        };
    };

    let connectedSource = null;

    const connect = (url, fallback = false) => {
        const es = new EventSource(url);

        es.onopen = () => {
            console.log(`SSE connected to ${url}`);
            connectedSource = es;
        };

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const normalized = normalize(data);
                if (typeof onNewEvent === 'function') onNewEvent(normalized);
            } catch (error) {
                console.error('Error parsing SSE data:', error);
            }
        };

        es.onerror = (err) => {
            console.error(`EventSource error for ${url}:`, err);
            if (url === privateUrl && fallback) {
                try {
                    es.close();
                } catch (e) {}
                connect(publicUrl, false);
            }
        };

        return es;
    };

    connect(privateUrl, true);
}

/**
 * Creates a table row element for a new feed item.
 * @param {object} item - The feed item data (message, icon, color, timeAgo).
 * @returns {HTMLTableRowElement} The created <tr> element.
 */
const createFeedItemRow = (item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td style="width: 40px;"><i class="fa ${item.icon} text-${item.color} fa-lg"></i></td>
        <td>${item.message}</td>
        <td style="width: 100px;"><i>${item.timeAgo}</i></td>
    `;
    return row;
};

// Expose setup function for dynamic loading
window.setupDashboardInteractions = function() {
    let source = 'userLogs'; // Default source
    let selectedCollection = null;
    const summaryCards = document.querySelectorAll('.summary-card');

    summaryCards.forEach(card => {
        card.addEventListener('click', function() {
            summaryCards.forEach(c => c.classList.remove('selected'));
            this.classList.add('selected');
            selectedCollection = this.getAttribute('data-collection');
            const worldMapTitle = document.getElementById('worldMapTitle');
            if (worldMapTitle) {
                worldMapTitle.innerText = `- ${selectedCollection.charAt(0).toUpperCase() + selectedCollection.slice(1)}`;
            }
            listAllLogs(selectedCollection); // Refresh the map with the selected source
        });
    });

    // Initialize world map with default data (userLogs)
    listAllLogs("userLogs");
};

document.addEventListener('DOMContentLoaded', async function() {
    const toggleMapDataFeed = document.getElementById('toggleMapDataFeed');
    const mapDataFeedCard = document.getElementById('mapDataFeedCard');

    if (toggleMapDataFeed) {
        toggleMapDataFeed.addEventListener('change', function() {
            mapDataFeedCard.style.display = this.checked ? 'block' : 'none';
        });
    }

    // Initialize the real-time feed
    initializeFeed((newItem) => {
        const feedTableBody = document.querySelector('.feed-scroll-container tbody');
        if (!feedTableBody) return;

        const newRow = createFeedItemRow(newItem);
        feedTableBody.prepend(newRow); // Add the new item to the top

        // Remove the "No items" message if it exists
        const noItemsRow = feedTableBody.querySelector('.no-items-row');
        if (noItemsRow) {
            noItemsRow.remove();
        }
    });

    // Draggable scroll for summary cards
    const scrollContainer = document.getElementById('card-scroll-container');
    let isDown = false;
    let startY;
    let scrollTop;

    if (scrollContainer) {
        scrollContainer.addEventListener('mousedown', (e) => {
            isDown = true;
            scrollContainer.classList.add('grabbing');
            startY = e.pageY - scrollContainer.offsetTop;
            scrollTop = scrollContainer.scrollTop;
        });

        scrollContainer.addEventListener('mouseleave', () => {
            isDown = false;
            scrollContainer.classList.remove('grabbing');
        });

        scrollContainer.addEventListener('mouseup', () => {
            isDown = false;
            scrollContainer.classList.remove('grabbing');
        });

        scrollContainer.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            const y = e.pageY - scrollContainer.offsetTop;
            const walk = (y - startY) * 2;
            scrollContainer.scrollTop = scrollTop - walk;
        });
    }
    
    // If cards are already present (static HTML), setup interactions
    if (document.querySelectorAll('.summary-card').length > 0) {
        window.setupDashboardInteractions();
    }
});

function generateCustomLegend() {
    const legendContainer = document.getElementById('worldMapLegend');
    if (!legendContainer) return;

    const legendData = [
        { color: 'rgba(0, 200, 100, 0.5)', label: '< 40 Hits' },
        { color: 'rgba(0, 100, 200, 0.7)', label: '>= 40 Hits' },
        { color: 'rgba(200, 200, 200, 0.25)', label: 'No Data' }
    ];

    let legendHTML = '<h5>Legend</h5><ul class="list-unstyled">';
    legendData.forEach(item => {
        legendHTML += `
            <li>
                <span class="legend-color-box" style="background-color:${item.color};"></span>
                ${item.label}
            </li>`;
    });
    legendHTML += '</ul>';

    legendContainer.innerHTML = legendHTML;
}


function setWorlGraph(data) {
    const countryNameCorrections = {
        "United States": "United States of America",
        "Russia": "Russian Federation",
        "South Korea": "Korea, Republic of",
    };

    // data can be either:
    // - an array of raw log objects where each entry has CountryName
    // - an aggregated array from the server: [{ _id: 'CountryName', count: N }, ...]
    let countryCounts = {};
    if (Array.isArray(data) && data.length > 0 && data[0] && Object.prototype.hasOwnProperty.call(data[0], '_id')) {
        // aggregated response
        data.forEach(item => {
            const name = item._id;
            if (!name) return;
            const corrected = countryNameCorrections[name] || name;
            countryCounts[corrected] = (countryCounts[corrected] || 0) + (parseInt(item.count, 10) || 0);
        });
    } else if (Array.isArray(data)) {
        // raw logs fall-back
        data.forEach(entry => {
            const name = entry && (entry.CountryName || entry.countryName || entry.country);
            if (!name) return;
            const corrected = countryNameCorrections[name] || name;
            countryCounts[corrected] = (countryCounts[corrected] || 0) + 1;
        });
    }

    updateMapDataFeed(countryCounts);

    fetch('https://unpkg.com/world-atlas/countries-50m.json')
        .then(response => response.json())
        .then(world => {
            const countries = ChartGeo.topojson.feature(world, world.objects.countries).features;
            const validCountryNames = new Set(countries.map(country => country.properties.name));
            Object.keys(countryCounts).forEach(countryName => {
                if (!validCountryNames.has(countryName)) {
                    // This console.warn is being removed as per code review feedback.
                    // console.warn(`Country name not found in ChartGeo countries list: ${countryName}`);
                }
            });
            const chartData = {
                labels: countries.map(d => d.properties.name),
                datasets: [{
                    label: 'Countries',
                    data: countries.map(country => ({
                        feature: country,
                        value: countryCounts[country.properties.name] || 0
                    })),
                    backgroundColor: (context) => {
                        const dataItem = context.dataset.data[context.dataIndex];
                        if (!dataItem || !dataItem.value) {
                            return 'rgba(200, 200, 200, 0.25)'; // Default grey for missing values
                        }
                        const value = dataItem.value;
                        if (value < 40) return `rgba(0, 200, 100, ${(value * 5) / 200 + 0.15})`;
                        return `rgba(0, 100, 200, ${(value * 3) / 100 + 0.1})`;
                    },
                }]
            };

            const config = {
                type: 'choropleth',
                data: chartData,
                options: {
                    showOutline: false,
                    showGraticule: false,
                     scales: {
                        projection: {
                            axis: 'x',
                            projection: 'equalEarth',
                        },
                        color: {
                            axis: 'x',
                            quantize: 5, // Example: 5 color steps
                            interpolate: 'YlGnBu', // Example: Yellow-Green-Blue color scheme
                            //display: false
                        }
                    },
                    plugins: {
                        legend: {
                            display: false // Keep the default legend off
                        }
                    }
                }
            };

            if (worldMap) {
                worldMap.destroy();
            }
            worldMap = new Chart(document.getElementById('worldMap'), config);
            generateCustomLegend(); // Call the function to generate our custom legend
        });
}

function updateMapDataFeed(countryCounts) {
    const dataFeedContainer = document.getElementById('mapDataFeed');
    if (!dataFeedContainer) return;

    let tableHTML = `
        <table class="table table-sm table-striped">
            <thead>
                <tr>
                    <th>Country</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const [country, value] of Object.entries(countryCounts)) {
        tableHTML += `
            <tr>
                <td>${country}</td>
                <td>${value}</td>
            </tr>
        `;
    }

    tableHTML += `
            </tbody>
        </table>
    `;

    dataFeedContainer.innerHTML = tableHTML;
}

const loadingElement = document.querySelector('.loading');

function listAllLogs(source) {
    if (loadingElement) loadingElement.style.display = '';
    const url = `api/v1/v2/logs?source=${source}`;
    fetch(url)
        .then(response => response.json())
        .then(result => {
            // Debugging: log meta and how many logs were returned
            try {
                console.log('[dashboard] get logs meta:', result.meta || {});
                const returned = (result.logs || []).length;
                console.log('[dashboard] logs returned:', returned);
                const sampleCountries = (result.logs || []).slice(0, 50).map(l => l && (l.CountryName || l.countryName || l.country)).filter(Boolean).slice(0,20);
                console.log('[dashboard] sample CountryName values:', sampleCountries);
            } catch (e) {
                console.warn('[dashboard] debug logging failed', e.message);
            }

            // Use the server-side aggregation endpoint to get authoritative counts for the world map
            fetch(`api/v1/v2/logs/countries?source=${source}`)
                .then(r => r.json())
                .then(countryResp => {
                    if (countryResp && countryResp.status === 'success' && Array.isArray(countryResp.data)) {
                        // countryResp.data is an array of {_id: 'CountryName', count: N}
                        setWorlGraph(countryResp.data);
                    } else {
                        // Fallback to the (paginated) logs if aggregation failed
                        setWorlGraph(result.logs || []);
                    }
                })
                .catch(err => {
                    console.warn('[dashboard] failed to fetch aggregated country counts, falling back to paginated logs', err && err.message);
                    setWorlGraph(result.logs || []);
                });

            if (loadingElement) loadingElement.style.display = 'none';
        })
        .catch(error => {
            console.error('Error fetching logs:', error);
            if (loadingElement) loadingElement.style.display = 'none';
        });
}

// loadDataTable function removed - use the dedicated databases viewer page instead

// Sidebar toggle functionality
var mySidebar = document.getElementById("mySidebar");
var overlayBg = document.getElementById("myOverlay");

window.w3_open = function() {
    if (mySidebar.style.display === 'block') {
        mySidebar.style.display = 'none';
        overlayBg.style.display = "none";
    } else {
        mySidebar.style.display = 'block';
        overlayBg.style.display = "block";
    }
}

window.w3_close = function() {
    mySidebar.style.display = "none";
    overlayBg.style.display = "none";
}