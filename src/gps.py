# gps helper functions
import utm
import math
import datetime


toronto_bl = 43.644057, -79.418834
toronto_tr = 43.670315, -79.386814


def x_y_to_gps(x, y, width, height, bottom_left_lat_long=toronto_bl, top_right_lat_long=toronto_tr, 
               angle_degrees=0, skew_x_degrees=0, skew_y_degrees=0, x_scale=1.0, y_scale=1.0):
    """
    Convert a single x,y coordinate to GPS coordinates with support for transformation.
    
    Args:
        x, y: Coordinates in the original space
        width, height: Dimensions of the original space
        bottom_left_lat_long: GPS coordinates of bottom left corner
        top_right_lat_long: GPS coordinates of top right corner
        angle_degrees: Rotation angle in degrees (clockwise from normal orientation)
        skew_x_degrees: Horizontal skew angle in degrees
        skew_y_degrees: Vertical skew angle in degrees
        x_scale: Scaling factor for x-coordinates
        y_scale: Scaling factor for y-coordinates
    
    Returns:
        (latitude, longitude) tuple
    """
    # Convert bottom-left and top-right lat/lon to UTM
    bl_lat, bl_lon = bottom_left_lat_long
    tr_lat, tr_lon = top_right_lat_long
    
    bl_easting, bl_northing, bl_zone_number, bl_zone_letter = utm.from_latlon(bl_lat, bl_lon)
    tr_easting, tr_northing, tr_zone_number, tr_zone_letter = utm.from_latlon(tr_lat, tr_lon)
    
    # Ensure both points are in the same UTM zone
    if bl_zone_number != tr_zone_number or bl_zone_letter != tr_zone_letter:
        raise ValueError("The two points are not in the same UTM zone")
    
    # Calculate the UTM coordinates of the point based on x, y, width, and height
    x_ratio = x / width
    y_ratio = y / height
    
    # Center the coordinate system (move to origin)
    x_centered = x_ratio - 0.5
    y_centered = y_ratio - 0.5
    
    # Apply scaling
    x_transformed = x_centered * x_scale
    y_transformed = y_centered * y_scale
    
    # Apply skew transformations
    if skew_x_degrees != 0:
        # Horizontal skew (shifts x based on y position)
        skew_x_rad = math.radians(skew_x_degrees)
        x_transformed += y_transformed * math.tan(skew_x_rad)
    
    if skew_y_degrees != 0:
        # Vertical skew (shifts y based on x position)
        skew_y_rad = math.radians(skew_y_degrees)
        y_transformed += x_transformed * math.tan(skew_y_rad)
    
    # Apply rotation if needed
    if angle_degrees != 0:
        angle_radians = math.radians(angle_degrees)
        x_rot = x_transformed * math.cos(angle_radians) - y_transformed * math.sin(angle_radians)
        y_rot = x_transformed * math.sin(angle_radians) + y_transformed * math.cos(angle_radians)
        x_transformed = x_rot
        y_transformed = y_rot
    
    # Move back from origin
    x_ratio = x_transformed + 0.5
    y_ratio = y_transformed + 0.5
    
    # Calculate the interpolated UTM coordinates
    point_easting = bl_easting + (tr_easting - bl_easting) * x_ratio
    point_northing = bl_northing + (tr_northing - bl_northing) * y_ratio
    
    # Convert the UTM coordinates back to lat/lon
    point_lat, point_lon = utm.to_latlon(point_easting, point_northing, bl_zone_number, bl_zone_letter)
    
    return point_lat, point_lon


def create_track_from_points(points, width, height, **kwargs):
    """
    Create a GPS track from a list of (x,y) points.
    
    Args:
        points: List of (x, y) tuples in pixel coordinates
        width, height: Dimensions of the coordinate space
        **kwargs: Additional parameters to pass to x_y_to_gps
        
    Returns:
        List of (latitude, longitude) tuples
    """
    gps_points = []
    for x, y in points:
        lat, lon = x_y_to_gps(x, y, width, height, **kwargs)
        gps_points.append((lat, lon))
    return gps_points


def export_to_gpx(gps_points: list[tuple[float, float]], output_file="track.gpx", name="Generated Track", description="Track generated from coordinates"):
    """
    Export a list of GPS coordinates to a GPX file.
    
    Args:
        gps_points: List of (latitude, longitude) tuples
        output_file: Path to save the output GPX file
        name: Name of the track
        description: Description of the track
    
    Returns:
        Path to the saved GPX file
    """
    # Create GPX header
    gpx_content = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GPS.py"',
        '     xmlns="http://www.topografix.com/GPX/1/1"',
        '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
        f'  <metadata>',
        f'    <name>{name}</name>',
        f'    <desc>{description}</desc>',
        f'    <time>{datetime.datetime.now().isoformat()}Z</time>',
        f'  </metadata>',
        '  <trk>',
        f'    <name>{name}</name>',
        '    <trkseg>'
    ]
    
    # Add track points
    for lat, lon in gps_points:
        gpx_content.append(f'      <trkpt lat="{lat}" lon="{lon}"></trkpt>')
    
    # Close the GPX structure
    gpx_content.extend([
        '    </trkseg>',
        '  </trk>',
        '</gpx>'
    ])
    
    # Write to file
    with open(output_file, 'w') as f:
        f.write('\n'.join(gpx_content))
    
    return output_file
