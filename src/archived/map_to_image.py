import folium
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import time
import tempfile



def calculate_bounding_box(coordinates):
    """Calculate the bounding box of the GPS coordinates."""
    min_lat = min(coord[0] for coord in coordinates)
    max_lat = max(coord[0] for coord in coordinates)
    min_lon = min(coord[1] for coord in coordinates)
    max_lon = max(coord[1] for coord in coordinates)
    return min_lat, max_lat, min_lon, max_lon


TILE_OPTIONS = {
    "OpenStreetMap": ("OpenStreetMap", None),
    "CartoDB positron": ("CartoDB positron", None),
    "CartoDB dark_matter": ("CartoDB dark_matter", None),
    "Esri World Imagery": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "Tiles &copy; Esri",
    ),
    "Esri World Topo": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        "Tiles &copy; Esri",
    ),
    "OpenTopoMap": (
        "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
    ),
}


def get_map_image(coordinates, width, height, zoom=15, tiles="OpenStreetMap"):
    """Generate a map image using Folium and Selenium."""
    min_lat, max_lat, min_lon, max_lon = calculate_bounding_box(coordinates)
    center_lat = (min_lat + max_lat) / 2
    center_lon = (min_lon + max_lon) / 2

    tile_url, attribution = TILE_OPTIONS.get(tiles, (tiles, None))
    if attribution:
        m = folium.Map(location=[center_lat, center_lon], zoom_start=zoom,
                       tiles=tile_url, attr=attribution)
    else:
        m = folium.Map(location=[center_lat, center_lon], zoom_start=zoom, tiles=tile_url)
    folium.PolyLine(coordinates, color="red", weight=2.5, opacity=0.8).add_to(m)

    # Save map to a temporary file
    with tempfile.NamedTemporaryFile(mode="w+", suffix=".html", delete=False) as tmp:
        m.save(tmp.name)
        tmp_name = tmp.name

    # Use Selenium to capture the map as an image
    options = Options()
    options.add_argument("--headless")
    driver = webdriver.Chrome(options=options)
    driver.set_window_size(width, height)
    driver.get(f"file://{tmp_name}")
    time.sleep(2)  # Wait for the map to load
    temp_folder = tempfile.mkdtemp()
    file_name = f"{temp_folder}/map.png"
    driver.save_screenshot(file_name)
    driver.quit()
    return file_name


if __name__ == "__main__":
    get_map_image([(37.373400, -122.079526), (37.372149, -122.08197)], 800, 600)