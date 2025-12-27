/**
 * @file API and networking utility functions.
 */

/**
 * Gets the hostname from the current URL.
 * @returns {string} The hostname of the current window location.
 */
export const getHostIP = () => {
  return window.location.hostname;
};

/**
 * Fetches the user's location data based on their IP address by calling a proxy endpoint.
 * @returns {Promise<object>} A promise that resolves with the location data.
 */
export const ipLookUp = async () => {
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
    throw error; // Re-throw the error for the caller to handle
  }
};

/**
 * Fetches the current location of the International Space Station (ISS).
 * @returns {Promise<object>} A promise that resolves with the ISS location data.
 */
export const getIssLocation = async () => {
  const ISS_API_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
  try {
    const response = await fetch(ISS_API_URL);
    if (!response.ok) {
      throw new Error(`Network response was not ok: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch ISS location:', error);
    throw error;
  }
};

/**
 * Generic GET request wrapper.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<any>} A promise that resolves with the response data.
 */
export const get = async (url) => {
  let targetUrl = url;

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }
    return await response.text();
  } catch (error) {
    console.error('Error in API.get:', error);
    throw error;
  }
};

/**
 * Posts data to a URL using the fetch API.
 * Handles URL-encoded form data.
 *
 * @param {string} url - The URL to post data to.
 * @param {URLSearchParams|string} data - The data to post, typically as a URLSearchParams object or a query string.
 * @returns {Promise<any>} A promise that resolves with the response data.
 */
export const postData = async (url = '', data = '') => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: data.toString(), // Ensure data is a string
    });

    if (!response.ok) {
      // Attempt to get more detailed error info from the body
      const errorBody = await response.text();
      throw new Error(`Request failed with status ${response.status}: ${errorBody}`);
    }

    // Check if the response is JSON before trying to parse it
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }
    return await response.text();

  } catch (error) {
    console.error('Error in postData:', error);
    throw error;
  }
};