//  Client-side Javascript tools + p5.js and data gathering

const Tools = {
    
    cliError: (err) => {          console.error(`ERROR(${err.code}): ${err.message}`)        },

    cliWarning: (warn) => {       console.warn(`WARNING(${warn.code}): ${warn.message}`)     },
    
    cliMsg: (msg) => {            console.log(msg)                                           },


    sleep: (ms) =>{        return new Promise(resolve => setTimeout(resolve, ms))        },


    getHostIP: ()=> {       return window.location.hostname                              },


    randomScalingFactor: () => {        return Math.round(Math.random() * 100)           },  // provide a random number from 0 to 100

    random_hex_color_code: () => {        return "#" + Math.floor(Math.random()*16777215).toString(16)    },    // provide a 16 digits hex value starting with #

    randomArray4: () => {        return [ Math.round(Math.random() * 100), Math.round(Math.random() * 100), Math.round(Math.random() * 100), Math.round(Math.random() * 100) ]    },     // provide a vector4 array with values from 0 to 100

    
    scale: (num, in_min, in_max, out_min, out_max) =>{     return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min    }, //  return the value scaled between min and max


    fillForm: (formId, data) => {

        const { elements } = document.getElementById(formId)

        for (const [ key, value ] of Object.entries(data) )
        {
            const field = elements.namedItem(key)
            field && (field.value = value)
        }
    },

    setDevicesListOnSelect: async (domElm, valuelist, selectedValue = "" ) => {   // sets values on a Select HTML element

        let selectedOption = 0
    
        if(valuelist.length != 0) {
            console.log('setting devices list on htmlSelect', valuelist )
            console.log('selected: ', selectedValue )
            for(let index in valuelist) {  // fill up select option array if devicesList is not empty
                domElm.options[domElm.options.length] = new Option(valuelist[index].id, index)
                if(valuelist[index].id === selectedValue) selectedOption = index
            }

            domElm.options[selectedOption].selected = "true"  //  set default selection

        }
        else  console.log('no value in provided array')
    },



    formatTime : (timestamp) => {
            // Create a new JavaScript Date object based on the timestamp and retreive time value from it
            var date = new Date(timestamp);
            var hours = date.getHours();
            var minutes =  date.getMinutes();
            var seconds = date.getSeconds();

            // Will display time in 10:30:23 format
            var formattedTime = hours.toString().padStart(2, '0') + ':' +
            minutes.toString().padStart(2, '0') + ':' +
            seconds.toString().padStart(2, '0');

            return(formattedTime)
    },

    

    toRadians: (degrees) => {
        return degrees * (Math.PI / 180);
    },

    haversineDistance: (lat1, lon1, lat2, lon2) => {
        const R = 6371; // Radius of the Earth in kilometers
        const dLat = Tools.toRadians(lat2 - lat1); // Assumes Tools is now defined or will be
        const dLon = Tools.toRadians(lon2 - lon1);
        const rLat1 = Tools.toRadians(lat1);
        const rLat2 = Tools.toRadians(lat2);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(rLat1) * Math.cos(rLat2) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;
        return distance; // in kilometers
    },

    isObjEmpty: (obj) => {
        for(let i in obj) return false
        return true
    },


    isGeoLocAvailable: () => {
            const yesno = ('geolocation' in navigator)
            console.log( yesno ? 'geolocation available:\n' : 'geolocation not available  :(') // Escaped

            return yesno
    },


    geoLocate: () => {
            return new Promise((resolve, reject) => {
                const options = { enableHighAccuracy: true,  maximumAge: 0  }
                navigator.geolocation.getCurrentPosition(resolve, reject, options)
            })
    },


    ipLookUp: async () => {
            try {
                //const response = await fetch('http://ip-api.com/json')
                const response = await fetch('/api/proxy-location')
                const data = await response.json()
                console.log('User\'s Location Data is ', data); // Escaped '
                console.log('User\'s Country', data.country); // Escaped '
                return data
            } catch (error) {
                console.log('Request failed.  Returned status of', error);
            }

    },


    getDOMSelectedOption: (select_id) => {
        var opt
        for ( var i = 0, len = select_id.options.length; i < len; i++ ) {
            opt = select_id.options[i]
            if ( opt.selected === true ) {
                break
            }
        }
        return opt
    },


    showArrayOnDOM: (listArray, domId) => {

        let items = listArray
        let listspan = document.createElement('span')

        document.getElementById(domId).appendChild(listspan)

        items.forEach( item =>{
            let li = document.createElement('p')
            listspan.appendChild(li)

            li.innerHTML += JSON.stringify(item, null, '\t')
        })
        const str = JSON.stringify(listArray, null, '\t')
        console.log(str)
    },

    data: {

        iss_location: async () => {
            try {
                const api_url = 'https://api.wheretheiss.at/v1/satellites/25544';
                const response = await fetch(api_url)
                const data = await response.json()
                return data
            }
            catch (e) {  console.log(e)   }
        },

        postData : async (url = '', data = '') => {
            let option = {
            method: 'POST',
            headers: {
                'Content-type': 'application/x-www-form-urlencoded',
                'Content-length': data.length
            },
            body : data
            }
            console.log (option)
            fetch(url, option)
                .then(response => response.text())
                .then(body => {
                    try {
                        return JSON.parse(body);
                    } catch {
                        throw Error(body);
                    }
                })
                .then(console.log)
                .catch(console.error)
        }
    },

      p5: {

        displayGrid: (r,l, color = 0, weight = 1) => {
            for (var x = -width/2; x < width/2; x += width / r) {
                for (var y = -height/2; y < height/2; y += height / l) {
                    stroke(color);
                    strokeWeight(weight);
                    line(x, -height/2, x, height/2);
                    line(-width /2, y, width/2, y);
                }
            }
        },

        mercX : (lon) => {
            lon = radians(lon);
            var a = (256 / PI) * pow(2, zoom); // zoom is not defined here, potential issue if used
            var b = lon + PI;
            return a * b;
        },

        mercY : (lat) => {
            lat = radians(lat);
            var a = (256 / PI) * pow(2, zoom); // zoom is not defined here
            var b = tan(PI / 4 + lat / 2);
            var c = PI - log(b);
            return a * c;
        },

        getMercatorCoord: (lon, lat, offsetx = 0, offsety = 0) => {
            let cx = Tools.p5.mercX(offsetx)
            let cy = Tools.p5.mercY(offsety)

            let x = Tools.p5.mercX(lon) - cx;
            let y = Tools.p5.mercY(lat) - cy;

            return ({x,y})
        },

        getSphereCoord: (rayon, latitude, longitude ) => {
            var theta = radians(latitude);
            var phi = radians(longitude) + HALF_PI; // Changed PI to HALF_PI
            var x = rayon * cos(theta) * cos(phi);
            var y = -rayon * sin(theta);
            var z = -rayon * cos(theta) * sin(phi);
            let vecCoord = createVector(x,y,z); // Assumes p5 'createVector' is available globally
            return vecCoord
        },

        getLatLonFromSphereCoord: (x, y, z, rayon) => {
            if (rayon === 0) return { lat: 0, lon: 0 };
            let valForAsin = -y / rayon;
            valForAsin = Math.max(-1.0, Math.min(1.0, valForAsin));
            let theta = Math.asin(valForAsin);
            let latDegrees = degrees(theta);
            let phi_offset_calc; // Renamed to avoid conflict if phi_offset was intended to be something else
            if (Math.abs(Math.cos(theta)) < 0.00001) {
                phi_offset_calc = 0;
            } else {
                phi_offset_calc = Math.atan2(-z, x);
            }
            let lonRadians = phi_offset_calc - HALF_PI; // Changed Math.PI to HALF_PI
            while (lonRadians <= -Math.PI) lonRadians += 2 * Math.PI;
            while (lonRadians > Math.PI) lonRadians -= 2 * Math.PI;
            let lonDegrees = degrees(lonRadians);
            return { lat: latDegrees, lon: lonDegrees };
        }
    },

    giveMeTextBetween: (source,  startTag,  endTag) => {
            let startIndex = source.indexOf(startTag);
            if (startIndex == -1) { return ""; }
            startIndex += startTag.length;
            let endIndex = source.indexOf(endTag, startIndex);
            if (endIndex == -1) { return ""; }
            return source.substring(startIndex, endIndex);
        }
}; // End of const Tools = { ... }

// find if a point (x,y) is within a circle:
//si  RacineCarré de (x^2 + y^2)    <= Rayon

/*
String url = "http://www.imdb.com/title/tt0058331";
// ... (rest of the commented out block) ...
String giveMeTextBetween(String s, String before, String after) {
  // ...
  return s.substring(start, end);
}
*/
