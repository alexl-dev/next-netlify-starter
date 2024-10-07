fetch('/.netlify/functions/weather')
    .then(response => response.json())
    .then(data => {
        const temp = data.main.temp;
        const description = data.weather[0].description;
        const weatherDiv = document.getElementById('weather');
        weatherDiv.innerHTML = `<p>Temperature: ${temp}°F</p><p>Condition: ${description}</p>`;
    })
    .catch(error => {
        console.error('Error fetching weather data:', error);
        document.getElementById('weather').innerHTML = 'Error fetching weather data.';
    });

