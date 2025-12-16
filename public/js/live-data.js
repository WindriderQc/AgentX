// Earth Explorer


/*
// Latitude and longitude are expected to be in radians!
float xPos = (_radius) * Mathf.Cos(latitude) * Mathf.Cos(longitude);
float zPos = (_radius) * Mathf.Cos(latitude) * Mathf.Sin(longitude);
float yPos = (_radius) * Mathf.Sin(latitude);
*/



// Quebec :  52.9399° N, 73.5491° W
// Top 100 Canadian municipalities by 2011 population
// https://github.com/dariusk/corpora/blob/master/data/geography/canadian_municipalities.json


var mapimg;
var mapStyle = 'mapbox/dark-v9';   //  mapbox/dark-v9   

var ww = 1200;
var hh = 800;

var cx, cy;
var zoom = 1; //  used in gathering Map and Coordinates system conversion




var earthquakes; // preloaded
var weather;  // actualized
let cityColor = 'blue'

var Iss;
var CityX = 0.0000;
var CityY = 0.0000;

// MQTT client (browser) - will be initialized with mqttConfig injected by the page
let _mqttClient = null;
let _mqttConnected = false;



function preload() 
{
  //mapimg = loadImage('https://api.mapbox.com/styles/v1/' + mapStyle + '/static/' +                
  //                   clon + ',' + clat + ',' + zoom + '/' +  ww + 'x' + hh + '?access_token=TOKEN', printMap);
  // mapimg.save('darkmap1200x800', 'png');   //  save image from API
  mapimg = loadImage('img/darkmap1200x800.png')
  earthquakes = loadStrings('data/quakes.csv')   
  //loadFont('Montserrat-Regular.otf',  drawText);
}



function drawText(font) 
{
  //fill('#ED225D');
  textSize(18);
 // textFont(font, 36);  
  stroke('#ff9d00'); 
  fill('#ff9d00');
  let s = 'Earthquakes in last month'
  text(s, -width/2 + 10, -height/2 + 20);
  stroke(0, 255, 0);
  fill(0, 255, 0, 255);
  s = 'International Space Station'
  text(s, -width/2 +10, -height/2 + 40);  
  //console.log('Legend printed.')
}


function displayEarthquakes()
{
  //console.log('Quakes all month: ' + earthquakes.length)

  for (var i = 1; i < earthquakes.length; i++) 
  {
    let data = earthquakes[i].split(/,/);  //  splitting csv
    //console.log(data);
    let lat = data[1];
    let lon = data[2];
    let mag = data[4];

    /*let x = Tools.mercX(lon) - cx;
    let y = Tools.mercY(lat) - cy;*/
    let {x,y} = Tools.p5.getMercatorCoord(lon, lat)
    // This addition fixes the case where the longitude is non-zero and
    // points can go off the screen.
    /*if(x < - width/2) {
      x += width;
    } else if(x > width / 2) {
      x -= width;
    }*/
    mag = pow(10, mag);  //  mapping magnitude exponentially with circle
    mag = sqrt(mag);
    let magmax = sqrt(pow(10, 10));
    let d = map(mag, 0, magmax, 0, 180);

    stroke('#ff9d00');
    fill('#ff9d00');
    ellipse(x, y, d, d);
  }
}



function getISS_location()
{
  // If we have live MQTT data, use it; otherwise fetch once from public API
  if (_mqttConnected && Iss && Iss.latitude !== undefined && Iss.longitude !== undefined) {
    let {x,y} = Tools.p5.getMercatorCoord(Iss.longitude, Iss.latitude)
    stroke(0, 255, 0)
    fill(0, 255, 0, 200)
    ellipse(x, y, 4, 4)
    // Update info panel if present
    const latEl = document.getElementById('lat');
    const lonEl = document.getElementById('lon');
    if (latEl) latEl.textContent = Iss.latitude;
    if (lonEl) lonEl.textContent = Iss.longitude;
    return;
  }

  console.log('Fetching ISS location from public API...')
  // Fallback: fetch from public API once
  const url = 'https://api.wheretheiss.at/v1/satellites/25544'
  loadJSON(url, (data) => {
        Iss = data

        let {x,y} = Tools.p5.getMercatorCoord(Iss.longitude,Iss.latitude)

        stroke(0, 255, 0)
        fill(0, 255, 0, 200)
        ellipse(x, y, 4, 4)
        const latEl = document.getElementById('lat');
        const lonEl = document.getElementById('lon');
        if (latEl) latEl.textContent = Iss.latitude;
        if (lonEl) lonEl.textContent = Iss.longitude;
  })
}


// Initialize MQTT in the browser using mqtt.js (loaded in the page)
function initFrontendMQTT(mqttConfig) {
  if (!mqttConfig || !mqttConfig.brokerUrl) return;
  try {
    const options = {};
    if (mqttConfig.username) options.username = mqttConfig.username;
    if (mqttConfig.password) options.password = mqttConfig.password;

  // Normalize brokerUrl to ws:// or wss:// so common config forms work (http(s), mqtt(s), ws(s))
  let brokerUrl = mqttConfig.brokerUrl || '';
  brokerUrl = brokerUrl.trim();
  if (brokerUrl.startsWith('https://')) brokerUrl = brokerUrl.replace(/^https?:\/\//, 'wss://');
  else if (brokerUrl.startsWith('http://')) brokerUrl = brokerUrl.replace(/^https?:\/\//, 'ws://');
  else if (brokerUrl.startsWith('mqtt://')) brokerUrl = brokerUrl.replace(/^mqtt:\/\//, 'ws://');
  else if (brokerUrl.startsWith('mqtts://')) brokerUrl = brokerUrl.replace(/^mqtts:\/\//, 'wss://');

  // indicate connecting state in UI
  const statusEl = document.getElementById('mqtt-status');
  if (statusEl) { statusEl.textContent = 'Connecting'; statusEl.className = 'mqtt-status connecting'; }

    // mqttConfig.brokerUrl is expected to be a ws:// or wss:// URL after normalization
    if (!brokerUrl) {
      console.warn('[live-data] No broker URL provided after normalization; skipping MQTT init.');
      if (statusEl) { statusEl.textContent = 'No broker'; statusEl.className = 'mqtt-status disconnected'; }
      return;
    }
    console.log('[live-data] attempting MQTT connect to', brokerUrl);
    _mqttClient = mqtt.connect(brokerUrl, options);

    _mqttClient.on('connect', () => {
      _mqttConnected = true;
      console.log('[live-data] Connected to MQTT broker');
      const status = document.getElementById('mqtt-status');
      if (status) { status.textContent = 'Connected'; status.className = 'mqtt-status connected'; }

      if (mqttConfig.issTopic) {
        _mqttClient.subscribe(mqttConfig.issTopic, (err) => {
          if (err) console.error('[live-data] MQTT subscribe error for ISS', err);
        });
      }
      if (mqttConfig.pressureTopic) {
        _mqttClient.subscribe(mqttConfig.pressureTopic, (err) => {
            if (err) console.error('[live-data] MQTT subscribe error for pressure', err);
        });
      }
    });

  _mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (topic === mqttConfig.issTopic) {
            // Accept { latitude, longitude, timeStamp } or nested iss_position
            if (payload.iss_position) {
              Iss = {
                latitude: Number(payload.iss_position.latitude),
                longitude: Number(payload.iss_position.longitude),
                timeStamp: payload.timestamp ? new Date(Number(payload.timestamp) * 1000) : new Date()
              };
            } else if (payload.latitude !== undefined && payload.longitude !== undefined) {
              Iss = {
                latitude: Number(payload.latitude),
                longitude: Number(payload.longitude),
                timeStamp: payload.timeStamp ? new Date(payload.timeStamp) : new Date()
              };
            }
            // Draw new ISS position (will accumulate as a trail)
            try { getISS_location(); } catch (e) { /* ignore if not available */ }
        } else if (topic === mqttConfig.pressureTopic) {
            const pressureElement = document.getElementById('pressure');
            const pressure = payload.pressure.toFixed(2);
            const time = new Date(payload.timeStamp).toLocaleTimeString();
            pressureElement.textContent = `${pressure} hPa`;
            updatePressureChart(time, pressure);
        }
      } catch (e) {
        console.error('[live-data] Error parsing MQTT message', e);
      }
    });

    _mqttClient.on('error', (err) => {
      console.error('[live-data] MQTT error', err);
      const status = document.getElementById('mqtt-status');
      if (status) { status.textContent = 'Error'; status.className = 'mqtt-status error'; }
    });

    _mqttClient.on('close', () => { _mqttConnected = false; console.log('[live-data] MQTT disconnected'); const status = document.getElementById('mqtt-status'); if (status) { status.textContent = 'Disconnected'; status.className = 'mqtt-status disconnected'; } });
    _mqttClient.on('reconnect', () => { const status = document.getElementById('mqtt-status'); if (status) { status.textContent = 'Reconnecting'; status.className = 'mqtt-status connecting'; } });
  } catch (err) {
    console.error('[live-data] Failed to init MQTT client', err);
  }
}

const pressureChartCtx = document.getElementById('pressureChart').getContext('2d');
const pressureChart = new Chart(pressureChartCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Barometric Pressure',
            data: [],
            borderColor: 'rgb(75, 192, 192)',
            tension: 0.1
        }]
    },
    options: {
        scales: {
            y: {
                beginAtZero: false
            }
        }
    }
});

function updatePressureChart(time, pressure) {
    pressureChart.data.labels.push(time);
    pressureChart.data.datasets[0].data.push(pressure);
    if (pressureChart.data.labels.length > 20) {
        pressureChart.data.labels.shift();
        pressureChart.data.datasets[0].data.shift();
    }
    pressureChart.update();
}

function drawBase(withGrid = false) 
{  
    image(mapimg, 0, 0)



    stroke(0, 0, 255)  // BLUE
    fill(0, 0, 255, 120)    //  BLUE + ALPHA
    let {x,y} = Tools.p5.getMercatorCoord(-71.2080,46.8139)
    ellipse(x, y, 10, 10)  // Show Qc City  -  46.8139° N, 71.2080° W

    drawText()

    displayEarthquakes()
    
    if(withGrid) Tools.p5.displayGrid(8,6,color(0,255,0,10), 1)
}


/*
function windowResized() 
{
  resizeCanvas(windowWidth, windowHeight);
  drawBase()
}
*/


function setup() {
 
  var canvas = createCanvas(ww, hh)
  canvas.parent(document.getElementById('mapDiv'))

  translate(width / 2, height / 2); //  set the 0,0 in the center of map
  imageMode(CENTER)
  drawBase()

  getISS_location()
  setInterval(getISS_location, 10000)

  // Initialize MQTT if mqttConfig is provided on the page
  try {
    if (typeof mqttConfig !== 'undefined') {
      initFrontendMQTT(JSON.parse(mqttConfig));
    }
  } catch (e) {
    // mqttConfig is already an object in some render paths
    try { initFrontendMQTT(mqttConfig); } catch (err) { console.warn('No mqttConfig available'); }
  }
  


}


function draw()
{
  translate(width / 2, height / 2); //  set the 0,0 in the center of map

 
}