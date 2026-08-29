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

    The two corner points define opposite corners of a rectangle rotated by angle_degrees
    (measured clockwise from North). The function decomposes the diagonal into the
    rectangle's actual length and width, then maps image coordinates into that rotated
    rectangle's local coordinate system. No skew correction is needed when the angle
    matches the rectangle's true orientation on the map.

    Args:
        x, y: Coordinates in the original space
        width, height: Dimensions of the original space
        bottom_left_lat_long: GPS coordinates of one corner (e.g. southwest)
        top_right_lat_long: GPS coordinates of the opposite corner (e.g. northeast)
        angle_degrees: Rotation angle in degrees clockwise from North
        skew_x_degrees: Horizontal skew angle in degrees (optional fine-tuning)
        skew_y_degrees: Vertical skew angle in degrees (optional fine-tuning)
        x_scale: Scaling factor for x-coordinates
        y_scale: Scaling factor for y-coordinates

    Returns:
        (latitude, longitude) tuple
    """
    bl_lat, bl_lon = bottom_left_lat_long
    tr_lat, tr_lon = top_right_lat_long

    bl_easting, bl_northing, bl_zone_number, bl_zone_letter = utm.from_latlon(bl_lat, bl_lon)
    tr_easting, tr_northing, tr_zone_number, tr_zone_letter = utm.from_latlon(tr_lat, tr_lon)

    if bl_zone_number != tr_zone_number or bl_zone_letter != tr_zone_letter:
        raise ValueError("The two points are not in the same UTM zone")

    center_e = (bl_easting + tr_easting) / 2
    center_n = (bl_northing + tr_northing) / 2

    dx = tr_easting - bl_easting
    dy = tr_northing - bl_northing

    angle_rad = math.radians(angle_degrees)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)

    L = dx * sin_a + dy * cos_a
    W = dx * cos_a - dy * sin_a

    x_ratio = x / width
    y_ratio = y / height

    x_centered = x_ratio - 0.5
    y_centered = y_ratio - 0.5

    x_transformed = x_centered * x_scale
    y_transformed = y_centered * y_scale

    if skew_x_degrees != 0:
        skew_x_rad = math.radians(skew_x_degrees)
        x_transformed += y_transformed * math.tan(skew_x_rad)

    if skew_y_degrees != 0:
        skew_y_rad = math.radians(skew_y_degrees)
        y_transformed += x_transformed * math.tan(skew_y_rad)

    u = y_transformed * L
    v = x_transformed * W

    point_easting = center_e + u * sin_a + v * cos_a
    point_northing = center_n + u * cos_a - v * sin_a

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
